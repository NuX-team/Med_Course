import { randomUUID } from 'node:crypto';
import {
  ForbiddenError,
  createRepositories,
  type Actor,
  type AnswerOutcome,
  type AppSession,
  type Database,
  type Executor,
  type LeftDoctor,
  type Repositories,
  type RepositoryDeps,
  type SkipReason,
} from '@medcourse/db';
import { t } from '@medcourse/i18n';
import { formatLocalDate } from '@medcourse/schedule';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import { WindowLimiter } from './limiter';
import {
  changeJson,
  courseJson,
  daysJson,
  doseJson,
  outlookJson,
  prnJson,
  reportJson,
  summaryJson,
} from './views';

export interface ApiDeps {
  readonly logger: FastifyBaseLogger;
  readonly db: Pick<Database, 'ping'>;
  readonly orm: Executor;
  readonly repositoryDeps: RepositoryDeps;
  /** The bot's username: sign-in links are t.me/<it>?start=a_<code>. */
  readonly botUsername: string;
  /** Tells a doctor something in Telegram (course started, change accepted, patient left). */
  readonly notify?: (telegramUserId: number, text: string) => Promise<void>;
  readonly now?: () => Date;
  readonly trustProxy?: boolean;
  readonly limits?: { readonly requestsPerMinute: number; readonly signInsPerMinute: number };
}

export const REQUESTS_PER_MINUTE = 120;
export const SIGN_INS_PER_MINUTE = 10;
const BODY_LIMIT_BYTES = 8 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const PUSH_TOKEN = /^[0-9A-Za-z_:-]{16,512}$/;
const SKIP_REASONS: readonly SkipReason[] = ['FORGOT', 'NO_MEDICATION', 'OTHER'];
const PROBE_PATHS = new Set(['/healthz', '/readyz']);

/** Never log request lines: the address carries ids, the headers carry the bearer token. */
const logController = new LogController({ disableRequestLogging: () => true });

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const notFound = (): ApiError => new ApiError(404, 'not_found');
const badRequest = (code = 'bad_request'): ApiError => new ApiError(400, code);

function pathOf(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? '';
}

function bodyField(request: FastifyRequest, name: string): unknown {
  const body = request.body;
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)[name]
    : undefined;
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown> | undefined)?.[name];
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw notFound();
  }
  return value;
}

function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** Answers are idempotent per key: the app sends one uuid per tap and repeats it on retry. */
function idempotencyKey(request: FastifyRequest): string {
  const header = request.headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (key === undefined || !KEY.test(key)) {
    throw badRequest('idempotency_key_required');
  }
  return `app:${key}`;
}

function platformOf(value: unknown): 'ios' | 'android' {
  if (value === undefined || value === 'ios') {
    return 'ios';
  }
  if (value === 'android') {
    return 'android';
  }
  throw badRequest();
}

/** What an answer to a dose comes to, over HTTP. */
function answerReply(outcome: AnswerOutcome) {
  switch (outcome.result) {
    case 'NOT_AVAILABLE':
      throw notFound();
    case 'DONE':
    case 'ALREADY':
      return { result: outcome.result, dose: doseJson(outcome.dose) };
    default:
      throw new ApiError(409, outcome.result.toLowerCase(), { dose: doseJson(outcome.dose) });
  }
}

/**
 * The mobile app's API (docs/MOBILE_API.md). JSON over HTTPS for one audience: a patient, signed
 * in by confirming in the bot. Every call goes through the same repositories as the bot with a
 * PATIENT actor, so what the app may see and do is exactly what the bot allows, re-checked in
 * SQL on every query. Reminders keep going through Telegram; the app is for looking and answering.
 */
export function buildApi(deps: ApiDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({
    loggerInstance: deps.logger,
    logController,
    genReqId: () => randomUUID(),
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: deps.trustProxy ?? false,
  });
  const repos = (): Repositories => createRepositories(deps.orm, deps.repositoryDeps);

  const requests = new WindowLimiter(
    deps.limits?.requestsPerMinute ?? REQUESTS_PER_MINUTE,
    60_000,
    () => now().getTime(),
  );
  const signIns = new WindowLimiter(
    deps.limits?.signInsPerMinute ?? SIGN_INS_PER_MINUTE,
    60_000,
    () => now().getTime(),
  );

  app.addHook('onRequest', async (request, reply) => {
    const path = pathOf(request);
    if (PROBE_PATHS.has(path)) {
      return undefined;
    }
    const verdicts = [
      requests.check(request.ip),
      ...(path === '/v1/auth/start' ? [signIns.check(request.ip)] : []),
    ];
    for (const verdict of verdicts) {
      if (!verdict.allowed) {
        reply.header('retry-after', String(Math.ceil(verdict.retryAfterMs / 1000)));
        return reply.code(429).send({ error: 'too_many_requests' });
      }
    }
    return undefined;
  });

  app.addHook('onResponse', (request, reply, done) => {
    const path = pathOf(request);
    if (!PROBE_PATHS.has(path)) {
      // The route pattern, not the address: no ids in the log.
      request.log.info(
        {
          method: request.method,
          route: request.routeOptions.url ?? 'unknown',
          status: reply.statusCode,
          ms: Math.round(reply.elapsedTime),
        },
        'request',
      );
    }
    done();
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ error: err.code, ...err.extra });
    }
    if (err instanceof ForbiddenError) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (err instanceof RangeError) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'bad_request' });
    }
    request.log.error({ code: (err as { code?: string }).code ?? 'UNKNOWN' }, 'request failed');
    return reply.code(500).send({ error: 'internal' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));

  /** Tells doctors after the fact; a failure is logged by code only and never fails the call. */
  const tell = async (
    request: FastifyRequest,
    messages: readonly { telegramUserId: number; text: string }[],
  ): Promise<void> => {
    if (deps.notify === undefined) {
      return;
    }
    for (const message of messages) {
      try {
        await deps.notify(message.telegramUserId, message.text);
      } catch (err) {
        request.log.warn({ code: (err as { code?: string }).code ?? 'NOTIFY' }, 'doctor not told');
      }
    }
  };

  interface Signed {
    readonly session: AppSession;
    readonly actor: Actor;
    readonly repos: Repositories;
  }

  /**
   * The signed-in patient, or 401. With consent withdrawn or a deletion waiting, only the
   * privacy screen is open (the bot does the same): `gated` routes refuse with 403.
   */
  const signed = async (request: FastifyRequest, gated = true): Promise<Signed> => {
    const token = bearerOf(request);
    const session = token === null ? null : await repos().appAuth.session({ token, now: now() });
    if (session === null) {
      throw new ApiError(401, 'unauthorized');
    }
    const actor: Actor = { kind: 'PATIENT', userId: session.userId };
    const all = repos();
    if (gated) {
      const standing = await all.privacy.standing(actor, session.userId);
      if (standing.consent === 'REVOKED' || standing.deletionDueAt !== null) {
        throw new ApiError(403, 'privacy_restricted');
      }
    }
    return { session, actor, repos: all };
  };

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

  // Sign-in -------------------------------------------------------------------------------

  app.post('/v1/auth/start', async () => {
    const started = await repos().appAuth.begin({ now: now() });
    if (started.status === 'BUSY') {
      throw new ApiError(429, 'too_many_requests');
    }
    return {
      botUrl: `https://t.me/${deps.botUsername}?start=a_${started.linkCode}`,
      pollToken: started.pollToken,
      expiresAt: started.expiresAt,
    };
  });

  app.post('/v1/auth/poll', async (request, reply) => {
    const pollToken = bodyField(request, 'pollToken');
    if (typeof pollToken !== 'string') {
      throw badRequest();
    }
    const result = await repos().appAuth.poll({
      pollToken,
      platform: platformOf(bodyField(request, 'platform')),
      now: now(),
    });
    switch (result.status) {
      case 'PENDING':
        return reply.code(202).send({ status: 'pending', expiresAt: result.expiresAt });
      case 'GONE':
        throw new ApiError(410, 'login_gone');
      case 'READY':
        return { status: 'ready', accessToken: result.token, expiresAt: result.expiresAt };
    }
  });

  app.post('/v1/auth/logout', async (request) => {
    const token = bearerOf(request);
    if (token !== null) {
      await repos().appAuth.signOut({ token, now: now() });
    }
    return { ok: true };
  });

  // The person -----------------------------------------------------------------------------

  const meOf = async ({ session, actor, repos: all }: Signed) => {
    const [summary, standing] = await Promise.all([
      all.patients.getSummary(actor, session.userId),
      all.privacy.standing(actor, session.userId),
    ]);
    if (summary === null) {
      throw new ApiError(401, 'unauthorized');
    }
    return {
      id: session.userId,
      firstName: summary.firstName,
      lastName: summary.lastName,
      locale: session.locale,
      timezone: session.timezone,
      consent: standing.consent,
      deletionDueAt: standing.deletionDueAt,
    };
  };

  app.get('/v1/me', async (request) => meOf(await signed(request, false)));

  app.patch('/v1/me', async (request) => {
    const who = await signed(request);
    const locale = bodyField(request, 'locale');
    if (locale !== undefined) {
      if (locale !== 'ru' && locale !== 'uz') {
        throw badRequest();
      }
      await who.repos.users.setLocale(who.actor, who.session.userId, locale);
    }
    return meOf({
      ...who,
      session: { ...who.session, ...(locale === undefined ? {} : { locale }) },
    });
  });

  app.post('/v1/me/device', async (request) => {
    const who = await signed(request);
    const token = bodyField(request, 'token');
    if (typeof token !== 'string' || !PUSH_TOKEN.test(token)) {
      throw badRequest();
    }
    await who.repos.appAuth.registerDevice(who.actor, {
      platform: platformOf(bodyField(request, 'platform')),
      token,
    });
    return { ok: true };
  });

  // Courses --------------------------------------------------------------------------------

  app.get('/v1/courses', async (request) => {
    const { actor, repos: all } = await signed(request);
    const [current, history] = await Promise.all([
      all.plans.listForPatient(actor),
      all.history.courses(actor),
    ]);
    const shown = new Set<string>();
    const courses = [];
    // Waiting to start, running and paused first; then the rest of the history.
    for (const plan of current) {
      shown.add(plan.course.id);
      const past = history.find((summary) => summary.plan.course.id === plan.course.id);
      courses.push(courseJson(plan, past?.adherence ?? null));
    }
    for (const summary of history) {
      if (!shown.has(summary.plan.course.id)) {
        courses.push(summaryJson(summary));
      }
    }
    return { courses };
  });

  app.get('/v1/courses/:id', async (request) => {
    const { actor, repos: all } = await signed(request);
    const courseId = param(request, 'id');
    const plan = await all.plans.getPlan(actor, courseId);
    if (plan === null || plan.course.status === 'DRAFT') {
      throw notFound();
    }
    const report = await all.history.report(actor, courseId);
    return {
      ...courseJson(plan, report?.adherence ?? null),
      report: report === null ? null : reportJson(report),
    };
  });

  app.get('/v1/courses/:id/start', async (request) => {
    const { actor, repos: all } = await signed(request);
    const preview = await all.runs.previewStart(actor, param(request, 'id'), now());
    if (preview.status === 'NOT_AVAILABLE') {
      throw notFound();
    }
    return preview.status === 'READY'
      ? { canStart: true, outlook: outlookJson(preview.outlook) }
      : {
          canStart: false,
          refusal: preview.status,
          ...('when' in preview ? { when: preview.when } : {}),
        };
  });

  app.post('/v1/courses/:id/start', async (request) => {
    const { actor, repos: all } = await signed(request);
    const result = await all.runs.start(actor, param(request, 'id'), now());
    if (result.status === 'NOT_AVAILABLE') {
      throw notFound();
    }
    if (result.status !== 'STARTED') {
      throw new ApiError(409, result.status.toLowerCase(), { course: courseJson(result.plan) });
    }
    const { plan, outlook, doctor } = result;
    await tell(request, [
      {
        telegramUserId: doctor.telegramUserId,
        text: t(doctor.locale, 'doctor.courseStarted', {
          patient: `${plan.patient.firstName} ${plan.patient.lastName}`,
          date: formatLocalDate(outlook.effectiveStartDate),
          last: formatLocalDate(outlook.lastDay),
        }),
      },
    ]);
    return { course: courseJson(plan), outlook: outlookJson(outlook) };
  });

  app.get('/v1/courses/:id/change', async (request) => {
    const { actor, repos: all } = await signed(request);
    const change = await all.changes.get(actor, param(request, 'id'));
    return { change: change === null ? null : changeJson(change) };
  });

  app.post('/v1/courses/:id/change/accept', async (request) => {
    const { actor, repos: all } = await signed(request);
    const result = await all.changes.accept(actor, {
      courseId: param(request, 'id'),
      now: now(),
      key: idempotencyKey(request),
    });
    switch (result.status) {
      case 'NOT_AVAILABLE':
        throw notFound();
      case 'NOTHING_PENDING':
      case 'DOCTOR_UNAVAILABLE':
        throw new ApiError(409, result.status.toLowerCase(), { course: courseJson(result.plan) });
      case 'APPLIED': {
        const { plan, doctor } = result;
        if (doctor !== null) {
          await tell(request, [
            {
              telegramUserId: doctor.telegramUserId,
              text: t(doctor.locale, 'doctor.changeAccepted', {
                patient: `${plan.patient.firstName} ${plan.patient.lastName}`,
              }),
            },
          ]);
        }
        return { course: courseJson(plan), nextDoseAt: result.firstSlotAt };
      }
    }
  });

  app.post('/v1/courses/:id/pause-request', async (request) => {
    const { actor, repos: all } = await signed(request);
    const result = await all.alerts.requestPause(actor, {
      courseId: param(request, 'id'),
      now: now(),
    });
    if (result.status === 'NOT_AVAILABLE') {
      throw notFound();
    }
    // The doctor is written to by the worker, through the alert queue.
    return { status: result.status === 'ALREADY' ? 'already' : 'requested' };
  });

  app.get('/v1/courses/:id/days', async (request) => {
    const { actor, repos: all } = await signed(request);
    const raw = (request.query as Record<string, unknown> | undefined)?.page;
    const page = typeof raw === 'string' && /^[1-9][0-9]{0,3}$/.test(raw) ? Number(raw) : 1;
    const found = await all.history.days(actor, {
      courseId: param(request, 'id'),
      page,
      now: now(),
    });
    if (found === null) {
      throw notFound();
    }
    return daysJson(found);
  });

  // Today and answers ----------------------------------------------------------------------

  app.get('/v1/today', async (request) => {
    const { actor, repos: all } = await signed(request);
    const at = now();
    const courses = await all.runs.today(actor, at);
    const doses = [];
    for (const course of courses) {
      for (const dose of course.doses) {
        const view = await all.answers.get(actor, dose.doseId, at);
        if (view !== null) {
          doses.push(doseJson(view));
        }
      }
    }
    doses.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    const asNeeded = await all.prn.available(actor, at);
    return { doses, asNeeded: asNeeded.map(prnJson) };
  });

  app.get('/v1/doses/:id', async (request) => {
    const { actor, repos: all } = await signed(request);
    const dose = await all.answers.get(actor, param(request, 'id'), now());
    if (dose === null) {
      throw notFound();
    }
    return { dose: doseJson(dose) };
  });

  app.post('/v1/doses/:id/take', async (request) => {
    const { actor, repos: all } = await signed(request);
    return answerReply(
      await all.answers.take(actor, {
        doseId: param(request, 'id'),
        now: now(),
        key: idempotencyKey(request),
      }),
    );
  });

  app.post('/v1/doses/:id/skip', async (request) => {
    const { actor, repos: all } = await signed(request);
    const reason = bodyField(request, 'reason');
    const note = bodyField(request, 'note');
    const known = SKIP_REASONS.find((candidate) => candidate === reason);
    if (known === undefined || (note !== undefined && note !== null && typeof note !== 'string')) {
      throw badRequest();
    }
    return answerReply(
      await all.answers.skip(actor, {
        doseId: param(request, 'id'),
        now: now(),
        key: idempotencyKey(request),
        reason: known,
        text: typeof note === 'string' ? note : null,
      }),
    );
  });

  app.post('/v1/doses/:id/snooze', async (request) => {
    const { actor, repos: all } = await signed(request);
    const minutes = bodyField(request, 'minutes');
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
      throw badRequest();
    }
    return answerReply(
      await all.answers.snooze(actor, {
        doseId: param(request, 'id'),
        now: now(),
        key: idempotencyKey(request),
        minutes,
      }),
    );
  });

  app.post('/v1/doses/:id/undo', async (request) => {
    const { actor, repos: all } = await signed(request);
    return answerReply(
      await all.answers.undo(actor, {
        doseId: param(request, 'id'),
        now: now(),
        key: idempotencyKey(request),
      }),
    );
  });

  // As needed ------------------------------------------------------------------------------

  app.post('/v1/prn/:id/take', async (request) => {
    const { actor, repos: all } = await signed(request);
    const result = await all.prn.take(actor, {
      medicationId: param(request, 'id'),
      now: now(),
      key: idempotencyKey(request),
    });
    if (result.status === 'NOT_AVAILABLE') {
      throw notFound();
    }
    return {
      result: result.status,
      overLimit: result.status === 'RECORDED' && result.over !== null,
      item: prnJson(result.item),
    };
  });

  app.post('/v1/prn/events/:id/undo', async (request) => {
    const { actor, repos: all } = await signed(request);
    const result = await all.prn.undo(actor, { eventId: param(request, 'id'), now: now() });
    if (result.status === 'NOT_AVAILABLE') {
      throw notFound();
    }
    if (result.status === 'NOT_CORRECTABLE') {
      throw new ApiError(409, 'not_correctable', { item: prnJson(result.item) });
    }
    return { result: result.status, item: prnJson(result.item) };
  });

  // Consent and data -----------------------------------------------------------------------

  const told = (doctors: readonly LeftDoctor[], name: string) =>
    doctors.map((doctor) => ({
      telegramUserId: doctor.telegramUserId,
      text: t(doctor.locale, 'privacy.doctorTold', { name, count: doctor.coursesStopped }),
    }));

  const nameOf = async ({ actor, session, repos: all }: Signed): Promise<string> => {
    const summary = await all.patients.getSummary(actor, session.userId);
    return summary === null ? '' : `${summary.firstName} ${summary.lastName}`;
  };

  app.get('/v1/privacy', async (request) => {
    const { actor, session, repos: all } = await signed(request, false);
    const [overview, standing] = await Promise.all([
      all.privacy.overview(actor),
      all.privacy.standing(actor, session.userId),
    ]);
    return {
      consent: overview.consent,
      decision: standing.consent,
      deletionDueAt: standing.deletionDueAt,
      doctors: overview.doctors,
      heldRole: overview.heldRole,
    };
  });

  app.post('/v1/privacy/withdraw', async (request) => {
    const who = await signed(request);
    const name = await nameOf(who);
    const result = await who.repos.privacy.withdrawConsent(who.actor, {
      now: now(),
      key: idempotencyKey(request),
    });
    if (result.status === 'HAS_ROLE') {
      throw new ApiError(409, 'has_role');
    }
    if (result.status === 'WITHDRAWN') {
      await tell(request, told(result.doctors, name));
    }
    return { ok: true };
  });

  app.post('/v1/privacy/delete-request', async (request) => {
    const who = await signed(request, false);
    const name = await nameOf(who);
    const result = await who.repos.privacy.requestDeletion(who.actor, {
      now: now(),
      key: idempotencyKey(request),
    });
    if (result.status === 'HAS_ROLE') {
      throw new ApiError(409, 'has_role');
    }
    if (result.status === 'REQUESTED') {
      await tell(request, told(result.doctors, name));
    }
    return { ok: true, eraseAt: result.dueAt };
  });

  app.post('/v1/privacy/delete-cancel', async (request) => {
    const { actor, repos: all } = await signed(request, false);
    return { ok: await all.privacy.cancelDeletion(actor, { now: now() }) };
  });

  return app;
}
