import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenError,
  createRepositories,
  type Actor,
  type Database,
  type Executor,
  type IncidentView,
  type PanelSession,
  type Repositories,
  type RepositoryDeps,
} from '@medcourse/db';
import { t, type Locale, type MessageKey } from '@medcourse/i18n';
import { formatLocalDateTime } from '@medcourse/schedule';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { STYLESHEET, html, join, page, type Child, type Markup } from './html';

export interface PanelDeps {
  readonly logger: FastifyBaseLogger;
  readonly db: Pick<Database, 'ping'>;
  readonly orm: Executor;
  readonly repositoryDeps: RepositoryDeps;
  /** The address staff open the panel at. An https one makes the session cookie Secure. */
  readonly baseUrl: string;
  /** Tells a doctor, in the bot, that they were verified. Absent when no bot token is configured. */
  readonly notify?: (telegramUserId: number, text: string) => Promise<void>;
  /** Injected so tests control the clock. */
  readonly now?: () => Date;
}

export const SESSION_COOKIE = 'mc_panel';
const SESSION_MAX_AGE_SECONDS = 12 * 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORM_LIMIT_BYTES = 16 * 1024;
/** The shape of a sign-in token: anything else is not looked up and never echoed into a page. */
const LOGIN_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** What may follow `?ok=` after a change: a fixed list, so nothing typed is ever echoed. */
const FLASHES = {
  verified: 'pn.doctors.verifiedDone',
  revoked: 'pn.doctors.revokedDone',
  staffAdded: 'pn.clinics.added',
  staffRevoked: 'pn.clinics.revoked',
  resolved: 'pn.inc.resolvedDone',
} as const satisfies Record<string, MessageKey>;
const PROBLEMS = {
  reference: 'pn.doctors.referenceRequired',
  staffNotFound: 'pn.clinics.notFound',
  noteTooLong: 'pn.inc.noteTooLong',
} as const satisfies Record<string, MessageKey>;

type TechActor = Extract<Actor, { kind: 'TECH_ADMIN' }>;
type ClinicActor = Extract<Actor, { kind: 'CLINIC_STAFF' }>;

const PROBE_PATHS = new Set(['/healthz', '/readyz']);
/**
 * Fastify's own request lines carry the full address, and the address of a sign-in link carries
 * its token. They are switched off; one line per request is written below, with the path only.
 */
const logController = new LogController({ disableRequestLogging: () => true });

function pathOf(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? '';
}

function cookieOf(request: FastifyRequest, name: string): string | null {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function field(body: unknown, name: string): string {
  const value =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : '';
  return typeof value === 'string' ? value : '';
}

function queryOf(request: FastifyRequest, name: string): string {
  return field(request.query, name);
}

/**
 * The staff panel (ARCHITECTURE §9, TZ §14): a handful of server-rendered pages. A person signs
 * in with a one-time link from the bot; after that every request names them by a cookie whose
 * token the database knows only as a hash, and what they may see is read from their staff
 * records each time. Two audiences that never overlap: technical administrators (doctors'
 * applications, staff, queues, the audit trail; no patient, no prescription) and a clinic's own
 * staff (that clinic's doctors, the state of its courses, its incidents).
 */
export function buildPanel(deps: PanelDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date());
  const secure = deps.baseUrl.startsWith('https://');
  const app = Fastify({
    loggerInstance: deps.logger,
    logController,
    genReqId: () => randomUUID(),
    bodyLimit: FORM_LIMIT_BYTES,
  });

  app.addHook('onResponse', (request, reply, done) => {
    const path = pathOf(request);
    if (!PROBE_PATHS.has(path)) {
      request.log.info(
        {
          method: request.method,
          path,
          status: reply.statusCode,
          ms: Math.round(reply.elapsedTime),
        },
        'request',
      );
    }
    done();
  });

  // Forms only: nothing in the panel accepts JSON or files.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(typeof body === 'string' ? body : '')));
    },
  );

  app.addHook('onSend', async (_request, reply) => {
    reply.header(
      'content-security-policy',
      "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    if (!reply.hasHeader('cache-control')) {
      // Pages name people: no browser or proxy keeps a copy.
      reply.header('cache-control', 'no-store');
    }
    if (secure) {
      reply.header('strict-transport-security', 'max-age=31536000');
    }
  });

  const reposFor = (request: FastifyRequest): Repositories =>
    createRepositories(deps.orm, { ...deps.repositoryDeps, requestId: request.id });

  // Pages ---------------------------------------------------------------------------------

  const send = (reply: FastifyReply, status: number, locale: Locale, body: Markup): FastifyReply =>
    reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(page({ lang: locale, title: t(locale, 'pn.title'), body }));

  /** A page for someone who is not signed in. The language is not known: both are shown. */
  const publicPage = (reply: FastifyReply, status: number, key: MessageKey, extra?: Markup) =>
    send(
      reply,
      status,
      'ru',
      html`<main>
        <h1>${t('ru', 'pn.loginTitle')} / ${t('uz', 'pn.loginTitle')}</h1>
        <p>${t('ru', key)}</p>
        <p>${t('uz', key)}</p>
        ${extra}
      </main>`,
    );

  const csrfField = (session: PanelSession): Markup =>
    html`<input type="hidden" name="_csrf" value="${session.csrfToken}" />`;

  const techOf = (session: PanelSession): TechActor | null => {
    for (const role of session.roles) {
      if (role.actor.kind === 'TECH_ADMIN') {
        return role.actor;
      }
    }
    return null;
  };

  const clinicOf = (session: PanelSession, clinicId: string): ClinicActor | null => {
    for (const role of session.roles) {
      if (role.actor.kind === 'CLINIC_STAFF' && role.actor.clinicId === clinicId) {
        return role.actor;
      }
    }
    return null;
  };

  /** The frame every signed-in page has: who you are, where you can go, how to leave. */
  const frame = (session: PanelSession, request: FastifyRequest, content: Child): Markup => {
    const { locale } = session;
    const link = (href: string, key: MessageKey, suffix = ''): Markup =>
      html`<a href="${href}">${t(locale, key)}${suffix}</a>`;
    const links: Markup[] = [link('/', 'pn.nav.home')];
    if (techOf(session) !== null) {
      links.push(
        link('/doctors', 'pn.nav.doctors'),
        link('/clinics', 'pn.nav.clinics'),
        link('/tech', 'pn.nav.tech'),
        link('/tech/incidents', 'pn.nav.techIncidents'),
        link('/audit', 'pn.nav.audit'),
      );
    }
    for (const role of session.roles) {
      if (role.actor.kind === 'CLINIC_STAFF' && 'clinicName' in role) {
        const base = `/clinic/${role.actor.clinicId}`;
        const suffix = `: ${role.clinicName}`;
        links.push(
          link(base, 'pn.nav.clinic', suffix),
          link(`${base}/courses`, 'pn.nav.courses', suffix),
          link(`${base}/incidents`, 'pn.nav.incidents', suffix),
        );
      }
    }
    const ok = queryOf(request, 'ok');
    const problem = queryOf(request, 'problem');
    return html`<header>
        <p>${t(locale, 'pn.signedInAs', { name: `${session.firstName} ${session.lastName}` })}</p>
        <nav>${links}</nav>
        <form method="post" action="/logout">
          ${csrfField(session)}
          <button class="quiet" type="submit">${t(locale, 'pn.signOut')}</button>
        </form>
      </header>
      <main>
        ${
          Object.hasOwn(FLASHES, ok)
            ? html`<p class="notice">${t(locale, FLASHES[ok as keyof typeof FLASHES])}</p>`
            : null
        }
        ${
          Object.hasOwn(PROBLEMS, problem)
            ? html`<p class="notice bad">
                ${t(locale, PROBLEMS[problem as keyof typeof PROBLEMS])}
              </p>`
            : null
        }
        ${content}
      </main>`;
  };

  const table = (headers: readonly string[], rows: readonly (readonly Child[])[]): Markup =>
    html`<div class="wide">
      <table>
        <thead>
          <tr>
            ${headers.map((header) => html`<th>${header}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (row) =>
              html`<tr>
                ${row.map((cell) => html`<td>${cell}</td>`)}
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`;

  const counts = (values: Readonly<Record<string, number>>): string => {
    const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
    return entries.length === 0
      ? '—'
      : entries.map(([key, n]) => `${key}: ${String(n)}`).join(', ');
  };

  // Guards --------------------------------------------------------------------------------

  /** The session of this request, or null after having answered with the sign-in page. */
  const signedIn = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<PanelSession | null> => {
    const token = cookieOf(request, SESSION_COOKIE);
    const session =
      token === null ? null : await reposFor(request).panel.session({ token, now: now() });
    if (session === null) {
      publicPage(reply, 401, 'pn.loginHow');
      return null;
    }
    return session;
  };

  const forbidden = (reply: FastifyReply, session: PanelSession, request: FastifyRequest) =>
    send(
      reply,
      403,
      session.locale,
      frame(session, request, html`<p class="notice bad">${t(session.locale, 'pn.forbidden')}</p>`),
    );

  /** A change: signed in, and the form carries this session's own token. */
  const changing = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<PanelSession | null> => {
    const session = await signedIn(request, reply);
    if (session === null) {
      return null;
    }
    if (!sameSecret(field(request.body, '_csrf'), session.csrfToken)) {
      send(
        reply,
        400,
        session.locale,
        frame(
          session,
          request,
          html`<p class="notice bad">${t(session.locale, 'pn.badRequest')}</p>`,
        ),
      );
      return null;
    }
    return session;
  };

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ForbiddenError) {
      // The role was there when the page was drawn and is gone now.
      return publicPage(reply, 403, 'pn.forbidden');
    }
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
    if (status >= 400 && status < 500) {
      return publicPage(reply, status, 'pn.badRequest');
    }
    request.log.error({ err: error }, 'unhandled error');
    return publicPage(reply, 500, 'pn.badRequest');
  });

  app.setNotFoundHandler((_request, reply) => publicPage(reply, 404, 'pn.notFound'));

  // Probes and static ---------------------------------------------------------------------

  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/readyz', async (request, reply) => {
    try {
      await deps.db.ping();
      return { status: 'ok', checks: { db: 'up' } };
    } catch (err) {
      request.log.warn({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable', checks: { db: 'down' } });
    }
  });
  app.get('/static/panel.css', (_request, reply) =>
    reply
      .type('text/css; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(STYLESHEET),
  );

  // Signing in and out --------------------------------------------------------------------

  // Opening the link only shows a button. Telegram (and mail scanners, and link previews) fetch
  // links on their own; if a GET spent the token, the person would arrive to a dead link.
  app.get('/login', (request, reply) => {
    const token = queryOf(request, 't');
    if (token === '') {
      return publicPage(reply, 200, 'pn.loginHow');
    }
    if (!LOGIN_TOKEN.test(token)) {
      return publicPage(reply, 400, 'pn.loginFailed');
    }
    return publicPage(
      reply,
      200,
      'pn.loginText',
      html`<form method="post" action="/login">
        <input type="hidden" name="t" value="${token}" />
        <button type="submit">${t('ru', 'pn.loginButton')} / ${t('uz', 'pn.loginButton')}</button>
      </form>`,
    );
  });

  app.post('/login', async (request, reply) => {
    const session = await reposFor(request).panel.redeemLogin({
      token: field(request.body, 't'),
      now: now(),
    });
    if (session === null) {
      return publicPage(reply, 400, 'pn.loginFailed');
    }
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=${session.sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(SESSION_MAX_AGE_SECONDS)}${secure ? '; Secure' : ''}`,
    );
    return reply.redirect('/', 303);
  });

  app.post('/logout', async (request, reply) => {
    const session = await changing(request, reply);
    if (session === null) {
      return reply;
    }
    const token = cookieOf(request, SESSION_COOKIE);
    if (token !== null) {
      await reposFor(request).panel.signOut({ token, now: now() });
    }
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`,
    );
    return reply.redirect('/login', 303);
  });

  // Home ----------------------------------------------------------------------------------

  app.get('/', async (request, reply) => {
    const session = await signedIn(request, reply);
    if (session === null) {
      return reply;
    }
    const { locale } = session;
    return send(
      reply,
      200,
      locale,
      frame(
        session,
        request,
        html`<h1>${t(locale, 'pn.title')}</h1>
          <p>${t(locale, 'pn.home.intro')}</p>
          <ul>
            ${session.roles.map((role) =>
              role.actor.kind === 'TECH_ADMIN'
                ? html`<li>${t(locale, 'pn.role.TECH_ADMIN')}</li>`
                : html`<li>
                    ${t(locale, `pn.role.${role.actor.role}`, {
                      clinic: 'clinicName' in role ? role.clinicName : '',
                    })}
                  </li>`,
            )}
          </ul>`,
      ),
    );
  });

  // Technical administrator ---------------------------------------------------------------

  app.get('/doctors', async (request, reply) => {
    const session = await signedIn(request, reply);
    if (session === null) {
      return reply;
    }
    const admin = techOf(session);
    if (admin === null) {
      return forbidden(reply, session, request);
    }
    const { locale, timezone } = session;
    const repos = reposFor(request);
    const section = async (
      status: 'PENDING' | 'VERIFIED' | 'REVOKED',
      title: MessageKey,
    ): Promise<Markup> => {
      const doctors = await repos.clinicians.listByStatus(admin, status);
      return html`<h2>${t(locale, title)}</h2>
        ${
          doctors.length === 0
            ? html`<p class="muted">${t(locale, 'pn.doctors.none')}</p>`
            : table(
                [
                  t(locale, 'pn.col.name'),
                  t(locale, 'pn.col.telegram'),
                  t(locale, 'pn.col.note'),
                  t(locale, 'pn.col.applied'),
                  t(locale, 'pn.col.reference'),
                  '',
                ],
                doctors.map((doctor) => [
                  `${doctor.lastName} ${doctor.firstName}`,
                  String(doctor.telegramUserId),
                  doctor.note ?? '—',
                  formatLocalDateTime(doctor.appliedAt, timezone),
                  doctor.verificationReference ?? '—',
                  status === 'VERIFIED'
                    ? html`<form method="post" action="/doctors/${doctor.userId}/revoke">
                        ${csrfField(session)}
                        <button class="quiet" type="submit">
                          ${t(locale, 'pn.doctors.revoke')}
                        </button>
                      </form>`
                    : html`<form method="post" action="/doctors/${doctor.userId}/verify">
                        ${csrfField(session)}
                        <label
                          >${t(locale, 'pn.doctors.referenceLabel')}
                          <input type="text" name="reference" maxlength="500" required />
                        </label>
                        <button type="submit">${t(locale, 'pn.doctors.verify')}</button>
                      </form>`,
                ]),
              )
        }`;
    };
    return send(
      reply,
      200,
      locale,
      frame(
        session,
        request,
        join([
          html`<h1>${t(locale, 'pn.nav.doctors')}</h1>`,
          await section('PENDING', 'pn.doctors.pending'),
          await section('VERIFIED', 'pn.doctors.verified'),
          await section('REVOKED', 'pn.doctors.revoked'),
        ]),
      ),
    );
  });

  app.post<{ Params: { id: string; verb: string } }>(
    '/doctors/:id/:verb',
    async (request, reply) => {
      const session = await changing(request, reply);
      if (session === null) {
        return reply;
      }
      const admin = techOf(session);
      const { id, verb } = request.params;
      if (admin === null) {
        return forbidden(reply, session, request);
      }
      if (!UUID.test(id) || (verb !== 'verify' && verb !== 'revoke')) {
        return publicPage(reply, 404, 'pn.notFound');
      }
      const repos = reposFor(request);
      if (verb === 'revoke') {
        const outcome = await repos.clinicians.revoke(admin, { clinicianId: id });
        return outcome === null
          ? publicPage(reply, 404, 'pn.notFound')
          : reply.redirect('/doctors?ok=revoked', 303);
      }
      const reference = field(request.body, 'reference').trim();
      if (reference.length === 0 || reference.length > 500) {
        return reply.redirect('/doctors?problem=reference', 303);
      }
      const outcome = await repos.clinicians.verify(admin, { clinicianId: id, reference });
      if (outcome === null) {
        return publicPage(reply, 404, 'pn.notFound');
      }
      if (outcome.changed && deps.notify !== undefined) {
        try {
          await deps.notify(outcome.telegramUserId, t(outcome.locale, 'doctor.verified'));
        } catch {
          // Not logged in detail: an HTTP error can carry the request address. The doctor will
          // see their new standing the next time they open the bot.
          request.log.warn('a verified doctor could not be told in the bot');
        }
      }
      return reply.redirect('/doctors?ok=verified', 303);
    },
  );

  app.get('/clinics', async (request, reply) => {
    const session = await signedIn(request, reply);
    if (session === null) {
      return reply;
    }
    const admin = techOf(session);
    if (admin === null) {
      return forbidden(reply, session, request);
    }
    const { locale } = session;
    const clinics = await reposFor(request).panel.clinics(admin);
    return send(
      reply,
      200,
      locale,
      frame(
        session,
        request,
        join([
          html`<h1>${t(locale, 'pn.nav.clinics')}</h1>`,
          clinics.map(
            (clinic) =>
              html`<h2>${clinic.name} (${t(locale, `pn.state.${clinic.status}`)})</h2>
                ${
                  clinic.staff.length === 0
                    ? html`<p class="muted">${t(locale, 'pn.clinics.noStaff')}</p>`
                    : table(
                        [
                          t(locale, 'pn.col.name'),
                          t(locale, 'pn.col.role'),
                          t(locale, 'pn.col.status'),
                          '',
                        ],
                        clinic.staff.map((member) => [
                          `${member.lastName} ${member.firstName}`,
                          t(
                            locale,
                            member.role === 'RECEPTION'
                              ? 'pn.clinics.roleReception'
                              : 'pn.clinics.roleAdmin',
                          ),
                          t(locale, `pn.state.${member.status}`),
                          member.status === 'ACTIVE'
                            ? html`<form method="post" action="/staff/${member.staffId}/revoke">
                                ${csrfField(session)}
                                <button class="quiet" type="submit">
                                  ${t(locale, 'pn.clinics.revoke')}
                                </button>
                              </form>`
                            : null,
                        ]),
                      )
                }
                <form method="post" action="/clinics/${clinic.clinicId}/staff">
                  ${csrfField(session)}
                  <label
                    >${t(locale, 'pn.clinics.telegramLabel')}
                    <input
                      type="text"
                      name="telegramId"
                      inputmode="numeric"
                      maxlength="15"
                      required
                    />
                  </label>
                  <label
                    >${t(locale, 'pn.col.role')}
                    <select name="role">
                      <option value="RECEPTION">${t(locale, 'pn.clinics.roleReception')}</option>
                      <option value="CLINIC_ADMIN">${t(locale, 'pn.clinics.roleAdmin')}</option>
                    </select>
                  </label>
                  <button type="submit">${t(locale, 'pn.clinics.add')}</button>
                </form>`,
          ),
        ]),
      ),
    );
  });

  app.post<{ Params: { id: string } }>('/clinics/:id/staff', async (request, reply) => {
    const session = await changing(request, reply);
    if (session === null) {
      return reply;
    }
    const admin = techOf(session);
    if (admin === null) {
      return forbidden(reply, session, request);
    }
    const telegramId = field(request.body, 'telegramId').trim();
    const role = field(request.body, 'role');
    if (
      !UUID.test(request.params.id) ||
      !/^[1-9][0-9]{0,14}$/.test(telegramId) ||
      (role !== 'RECEPTION' && role !== 'CLINIC_ADMIN')
    ) {
      return reply.redirect('/clinics?problem=staffNotFound', 303);
    }
    const added = await reposFor(request).panel.addClinicStaff(admin, {
      clinicId: request.params.id,
      telegramUserId: Number(telegramId),
      role,
    });
    return reply.redirect(
      added.status === 'NOT_FOUND' ? '/clinics?problem=staffNotFound' : '/clinics?ok=staffAdded',
      303,
    );
  });

  app.post<{ Params: { id: string } }>('/staff/:id/revoke', async (request, reply) => {
    const session = await changing(request, reply);
    if (session === null) {
      return reply;
    }
    const admin = techOf(session);
    if (admin === null) {
      return forbidden(reply, session, request);
    }
    if (!UUID.test(request.params.id)) {
      return publicPage(reply, 404, 'pn.notFound');
    }
    const revoked = await reposFor(request).panel.revokeClinicStaff(admin, request.params.id);
    return revoked
      ? reply.redirect('/clinics?ok=staffRevoked', 303)
      : publicPage(reply, 404, 'pn.notFound');
  });

  app.get('/tech', async (request, reply) => {
    const session = await signedIn(request, reply);
    if (session === null) {
      return reply;
    }
    const admin = techOf(session);
    if (admin === null) {
      return forbidden(reply, session, request);
    }
    const { locale } = session;
    const stats = await reposFor(request).panel.techStats(admin, now());
    const number = (value: number | null): string => (value === null ? '—' : String(value));
    const queue = (title: MessageKey, queued: typeof stats.alerts, extra: Child[][] = []): Markup =>
      html`<h2>${t(locale, title)}</h2>
        ${table(
          ['', ''],
          [
            [t(locale, 'pn.tech.byStatus'), counts(queued.byStatus)],
            [t(locale, 'pn.tech.overdue'), queued.overdue],
            [t(locale, 'pn.tech.oldest'), number(queued.oldestOverdueSeconds)],
            [t(locale, 'pn.tech.stuck'), queued.stuck],
            [t(locale, 'pn.tech.failures'), counts(queued.failures)],
            ...extra,
          ],
        )}`;
    return send(
      reply,
      200,
      locale,
      frame(
        session,
        request,
        join([
          html`<h1>${t(locale, 'pn.nav.tech')}</h1>
            <p class="muted">${t(locale, 'pn.tech.note')}</p>`,
          queue('pn.tech.reminders', stats.reminders, [
            [t(locale, 'pn.tech.sent'), stats.reminders.sentInDay],
            [
              t(locale, 'pn.tech.delay'),
              `${number(stats.reminders.delaySecondsP50)} / ${number(stats.reminders.delaySecondsP95)}`,
            ],
          ]),
          queue('pn.tech.alerts', stats.alerts),
          table(
            ['', ''],
            [
              [t(locale, 'pn.tech.unswept'), stats.unsweptDoses],
              [t(locale, 'pn.tech.courses'), counts(stats.courses)],
              [t(locale, 'pn.tech.doctors'), counts(stats.doctors)],
              [t(locale, 'pn.tech.users'), stats.users],
            ],
          ),
        ]),
      ),
    );
  });

  /** Incidents, open and closed, with the form that closes one. Shared by both audiences. */
  const incidentsPage = async (
    request: FastifyRequest,
    session: PanelSession,
    actor: TechActor | ClinicActor,
    base: string,
  ): Promise<Markup> => {
    const { locale, timezone } = session;
    const repos = reposFor(request);
    const clinic = actor.kind === 'CLINIC_STAFF';
    const describe = (incident: IncidentView): Child[] => [
      formatLocalDateTime(incident.openedAt, timezone),
      t(locale, `pn.inc.type.${incident.type}`),
      ...(clinic
        ? [
            incident.course?.patientName ??
              html`<span class="muted">${t(locale, 'pn.inc.nameHidden')}</span>`,
            incident.course?.clinicianName ?? '—',
          ]
        : [
            incident.details === null
              ? '—'
              : Object.entries(incident.details)
                  .map(([key, value]) => `${key}: ${String(value)}`)
                  .join(', '),
          ]),
    ];
    const headers = [
      t(locale, 'pn.inc.opened'),
      t(locale, 'pn.inc.what'),
      ...(clinic
        ? [t(locale, 'pn.col.patient'), t(locale, 'pn.col.doctor')]
        : [t(locale, 'pn.inc.details')]),
    ];
    const open = await repos.incidents.list(actor, 'OPEN');
    const closed = await repos.incidents.list(actor, 'RESOLVED');
    return join([
      html`<h1>${t(locale, clinic ? 'pn.nav.incidents' : 'pn.nav.techIncidents')}</h1>`,
      clinic ? html`<p class="muted">${t(locale, 'pn.inc.callHint')}</p>` : null,
      html`<h2>${t(locale, 'pn.inc.open')}</h2>`,
      open.length === 0
        ? html`<p class="muted">${t(locale, 'pn.inc.none')}</p>`
        : table(
            [...headers, ''],
            open.map((incident) => [
              ...describe(incident),
              html`<form method="post" action="${base}/${incident.id}/resolve">
                ${csrfField(session)}
                <label
                  >${t(locale, 'pn.inc.noteLabel')}
                  <textarea name="note" rows="2" maxlength="500"></textarea>
                </label>
                <button type="submit">${t(locale, 'pn.inc.resolve')}</button>
              </form>`,
            ]),
          ),
      html`<h2>${t(locale, 'pn.inc.resolved')}</h2>`,
      closed.length === 0
        ? html`<p class="muted">${t(locale, 'pn.inc.none')}</p>`
        : table(
            [...headers, t(locale, 'pn.inc.note')],
            closed.map((incident) => [...describe(incident), incident.note ?? '—']),
          ),
    ]);
  };

  const resolveIncident = async (
    request: FastifyRequest,
    reply: FastifyReply,
    actor: TechActor | ClinicActor,
    incidentId: string,
    base: string,
  ): Promise<FastifyReply> => {
    if (!UUID.test(incidentId)) {
      return publicPage(reply, 404, 'pn.notFound');
    }
    const note = field(request.body, 'note');
    if (Array.from(note.trim()).length > 500) {
      return reply.redirect(`${base}?problem=noteTooLong`, 303);
    }
    const done = await reposFor(request).incidents.resolve(actor, { incidentId, note, now: now() });
    return done
      ? reply.redirect(`${base}?ok=resolved`, 303)
      : publicPage(reply, 404, 'pn.notFound');
  };

  app.get('/tech/incidents', async (request, reply) => {
    const session = await signedIn(request, reply);
    if (session === null) {
      return reply;
    }
    const admin = techOf(session);
    if (admin === null) {
      return forbidden(reply, session, request);
    }
    return send(
      reply,
      200,
      session.locale,
      frame(session, request, await incidentsPage(request, session, admin, '/tech/incidents')),
    );
  });

  app.post<{ Params: { id: string } }>('/tech/incidents/:id/resolve', async (request, reply) => {
    const session = await changing(request, reply);
    if (session === null) {
      return reply;
    }
    const admin = techOf(session);
    return admin === null
      ? forbidden(reply, session, request)
      : resolveIncident(request, reply, admin, request.params.id, '/tech/incidents');
  });

  app.get('/audit', async (request, reply) => {
    const session = await signedIn(request, reply);
    if (session === null) {
      return reply;
    }
    const admin = techOf(session);
    if (admin === null) {
      return forbidden(reply, session, request);
    }
    const { locale, timezone } = session;
    const type = queryOf(request, 'type').trim();
    const before = queryOf(request, 'before');
    const entityType = /^[a-z_]{1,40}$/.test(type) ? type : undefined;
    const beforeId = /^[1-9][0-9]{0,15}$/.test(before) ? Number(before) : undefined;
    const rows = await reposFor(request).panel.auditTrail(admin, {
      ...(entityType === undefined ? {} : { entityType }),
      ...(beforeId === undefined ? {} : { beforeId }),
    });
    const last = rows.at(-1);
    return send(
      reply,
      200,
      locale,
      frame(
        session,
        request,
        html`<h1>${t(locale, 'pn.nav.audit')}</h1>
          <p class="muted">${t(locale, 'pn.audit.note')}</p>
          <form method="get" action="/audit">
            <label
              >${t(locale, 'pn.audit.filter')}
              <input type="text" name="type" maxlength="40" value="${entityType ?? ''}" />
            </label>
            <button type="submit">${t(locale, 'pn.audit.apply')}</button>
          </form>
          ${table(
            [
              t(locale, 'pn.col.when'),
              t(locale, 'pn.col.actor'),
              t(locale, 'pn.col.entity'),
              t(locale, 'pn.col.action'),
              t(locale, 'pn.col.fields'),
            ],
            rows.map((row) => [
              formatLocalDateTime(row.at, timezone),
              row.actorRef === null ? row.actorKind : `${row.actorKind} ${row.actorRef}`,
              `${row.entityType} ${row.entityRef}`,
              row.action,
              row.changes.join(', '),
            ]),
          )}
          ${
            last === undefined
              ? null
              : html`<p>
                  <a
                    href="/audit?before=${last.id}${
                      entityType === undefined ? '' : `&type=${entityType}`
                    }"
                    >${t(locale, 'pn.audit.older')}</a
                  >
                </p>`
          }`,
      ),
    );
  });

  // Clinic staff --------------------------------------------------------------------------

  /** The session and this person's capacity in the clinic the address names. */
  const inClinic = async (
    request: FastifyRequest<{ Params: { clinicId: string } }>,
    reply: FastifyReply,
    change: boolean,
  ): Promise<{ session: PanelSession; staff: ClinicActor } | null> => {
    const session = change ? await changing(request, reply) : await signedIn(request, reply);
    if (session === null) {
      return null;
    }
    const staff = UUID.test(request.params.clinicId)
      ? clinicOf(session, request.params.clinicId)
      : null;
    if (staff === null) {
      // Not one's own clinic and no such clinic look the same.
      forbidden(reply, session, request);
      return null;
    }
    return { session, staff };
  };

  app.get<{ Params: { clinicId: string } }>('/clinic/:clinicId', async (request, reply) => {
    const found = await inClinic(request, reply, false);
    if (found === null) {
      return reply;
    }
    const { session, staff } = found;
    const { locale } = session;
    const overview = await reposFor(request).panel.clinicOverview(staff);
    return send(
      reply,
      200,
      locale,
      frame(
        session,
        request,
        html`<h1>${overview.clinicName}</h1>
          <h2>${t(locale, 'pn.clinic.doctors')}</h2>
          ${table(
            [t(locale, 'pn.col.name'), t(locale, 'pn.col.status')],
            overview.doctors.map((doctor) => [
              `${doctor.lastName} ${doctor.firstName}`,
              t(locale, `pn.verification.${doctor.verificationStatus}`),
            ]),
          )}`,
      ),
    );
  });

  app.get<{ Params: { clinicId: string } }>('/clinic/:clinicId/courses', async (request, reply) => {
    const found = await inClinic(request, reply, false);
    if (found === null) {
      return reply;
    }
    const { session, staff } = found;
    const { locale, timezone } = session;
    const courses = await reposFor(request).panel.clinicCourses(staff);
    const when = (at: Date | null): string =>
      at === null ? '—' : formatLocalDateTime(at, timezone);
    return send(
      reply,
      200,
      locale,
      frame(
        session,
        request,
        html`<h1>${t(locale, 'pn.courses.title')}</h1>
          <p class="muted">${t(locale, 'pn.courses.note')}</p>
          ${
            courses.length === 0
              ? html`<p class="muted">${t(locale, 'pn.courses.none')}</p>`
              : table(
                  [
                    t(locale, 'pn.col.patient'),
                    t(locale, 'pn.col.doctor'),
                    t(locale, 'pn.col.status'),
                    t(locale, 'pn.col.days'),
                    t(locale, 'pn.col.started'),
                    t(locale, 'pn.col.ended'),
                  ],
                  courses.map((course) => [
                    course.patientName ??
                      html`<span class="muted">${t(locale, 'pn.inc.nameHidden')}</span>`,
                    course.clinicianName,
                    t(locale, `status.${course.status}`),
                    course.durationDays,
                    when(course.startAt),
                    when(course.endedAt),
                  ]),
                )
          }`,
      ),
    );
  });

  app.get<{ Params: { clinicId: string } }>(
    '/clinic/:clinicId/incidents',
    async (request, reply) => {
      const found = await inClinic(request, reply, false);
      if (found === null) {
        return reply;
      }
      const { session, staff } = found;
      return send(
        reply,
        200,
        session.locale,
        frame(
          session,
          request,
          await incidentsPage(request, session, staff, `/clinic/${staff.clinicId}/incidents`),
        ),
      );
    },
  );

  app.post<{ Params: { clinicId: string; id: string } }>(
    '/clinic/:clinicId/incidents/:id/resolve',
    async (request, reply) => {
      const found = await inClinic(request, reply, true);
      if (found === null) {
        return reply;
      }
      return resolveIncident(
        request,
        reply,
        found.staff,
        request.params.id,
        `/clinic/${found.staff.clinicId}/incidents`,
      );
    },
  );

  return app;
}
