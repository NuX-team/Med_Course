import { randomBytes } from 'node:crypto';
import {
  createRepositories,
  createRepositoryDeps,
  systemActor,
  type Repositories,
  type RepositoryDeps,
} from '@medcourse/db';
import {
  createTestDatabase,
  insertClinic,
  insertClinician,
  insertPatient,
  startRunningCourse,
  type RunningCourse,
  type TestDatabase,
} from '@medcourse/db/testing';
import { t } from '@medcourse/i18n';
import { createLogger } from '@medcourse/logger';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildPanel } from './app';

/**
 * The staff panel over HTTP, against a real database. The acceptance rule of the stage is the
 * section "each role sees only its own": the front desk of a clinic and a technical
 * administrator are sent the same addresses and must each be refused the other's pages.
 * The course in these tests is "Testamol", prescribed by "Rustam Tor" to "Aziza Karimova".
 */

let testDatabase: TestDatabase;
let repos: Repositories;
let repositoryDeps: RepositoryDeps;
let app: FastifyInstance;
let clock: Date;
let told: [number, string][];
let failNotify = false;

const NOW = new Date('2026-10-03T04:00:00Z');
const BASE_URL = 'https://panel.medcourse.test';
const HOUR = 3_600_000;
const sql = () => testDatabase.db.sql;
const system = systemActor('panel app test');
const logger = createLogger({ service: 'panel-test', level: 'silent' });
let telegramId = 80_000_000;

const local = (day: number, time: string): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 2 + day, (hours ?? 0) - 5, minutes ?? 0));
};

function build(options: { baseUrl?: string; stream?: { write(line: string): void } } = {}) {
  return buildPanel({
    logger:
      options.stream === undefined
        ? logger
        : createLogger({ service: 'panel-test', level: 'info', stream: options.stream }),
    db: testDatabase.db,
    orm: testDatabase.db.orm,
    repositoryDeps,
    baseUrl: options.baseUrl ?? BASE_URL,
    notify: (telegramUserId, text) => {
      if (failNotify) {
        return Promise.reject(new Error('https://api.telegram.org/bot123:secret/sendMessage'));
      }
      told.push([telegramUserId, text]);
      return Promise.resolve();
    },
    now: () => clock,
  });
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
  repos = createRepositories(testDatabase.db.orm, repositoryDeps);
  app = build();
});

afterAll(async () => {
  await app.close();
  await testDatabase.drop();
});

beforeEach(() => {
  clock = NOW;
  told = [];
  failNotify = false;
});

interface Person {
  readonly userId: string;
  readonly telegramUserId: number;
}

async function person(firstName = 'Staff', lastName = 'Member'): Promise<Person> {
  telegramId += 1;
  return {
    userId: await insertPatient(sql(), { telegramId, firstName, lastName }),
    telegramUserId: telegramId,
  };
}

async function techAdmin(): Promise<Person> {
  const who = await person('Tech', 'Admin');
  await repos.platform.grantTechAdmin(system, who.userId);
  return who;
}

async function staffOf(
  clinicId: string,
  role: 'RECEPTION' | 'CLINIC_ADMIN' = 'RECEPTION',
): Promise<Person> {
  const who = await person('Front', 'Desk');
  const added = await repos.panel.addClinicStaff(system, {
    clinicId,
    telegramUserId: who.telegramUserId,
    role,
  });
  expect(added.status).toBe('ADDED');
  return who;
}

const running = (): Promise<RunningCourse> => startRunningCourse(sql(), repos);

async function linkFor(who: Person): Promise<string> {
  const issued = await repos.panel.issueLogin(system, { userId: who.userId, now: clock });
  if (issued.status !== 'ISSUED') {
    throw new Error(`no sign-in link: ${issued.status}`);
  }
  return issued.token;
}

type Fields = Readonly<Record<string, string>>;

function form(fields: Fields) {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  };
}

/** What a signed-in browser does: sends its cookie, and the token of the page it is on. */
class Browser {
  readonly cookie: string;
  readonly #app: FastifyInstance;

  constructor(cookie: string, target: FastifyInstance = app) {
    this.cookie = cookie;
    this.#app = target;
  }

  get(url: string) {
    return this.#app.inject({ method: 'GET', url, headers: { cookie: this.cookie } });
  }

  async csrf(): Promise<string> {
    const page = await this.get('/');
    return /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
  }

  /** A form sent from one of the panel's own pages. `csrf: null` leaves the token out. */
  async post(url: string, fields: Fields = {}, csrf?: string | null) {
    const token = csrf === undefined ? await this.csrf() : csrf;
    const { headers, payload } = form(token === null ? fields : { ...fields, _csrf: token });
    return this.#app.inject({
      method: 'POST',
      url,
      headers: { ...headers, cookie: this.cookie },
      payload,
    });
  }
}

async function signIn(who: Person, target: FastifyInstance = app): Promise<Browser> {
  const response = await target.inject({
    method: 'POST',
    url: '/login',
    ...form({ t: await linkFor(who) }),
  });
  const cookie = String(response.headers['set-cookie']).split(';')[0] ?? '';
  expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return new Browser(cookie, target);
}

/** Three moments in a row left unanswered: the third opens an incident for the clinic. */
async function missedThree(c: RunningCourse): Promise<string> {
  await sql()`
    update treatment_courses set status = 'PAUSED' where status = 'ACTIVE' and id <> ${c.courseId}`;
  for (const now of [local(1, '08:30'), local(1, '20:30'), local(2, '08:30')]) {
    while ((await repos.answers.sweepMissed(system, now)) > 0) {
      // until nothing is left
    }
  }
  const [incident] = await sql()<{ id: string }[]>`
    select id from incidents where course_id = ${c.courseId} and type = 'MISS_SERIES'`;
  return incident?.id ?? '';
}

const incidentStatus = async (id: string): Promise<string | undefined> =>
  (await sql()<{ status: string }[]>`select status from incidents where id = ${id}`)[0]?.status;

const doctorStatus = async (id: string): Promise<string | undefined> =>
  (
    await sql()<{ verification_status: string }[]>`
      select verification_status from clinician_profiles where user_id = ${id}`
  )[0]?.verification_status;

describe('probes and plumbing', () => {
  it('answers /healthz always and /readyz only while the database does', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).json()).toEqual({
      status: 'ok',
      checks: { db: 'up' },
    });
    const down = buildPanel({
      logger,
      db: { ping: () => Promise.reject(new Error('down')) },
      orm: testDatabase.db.orm,
      repositoryDeps,
      baseUrl: BASE_URL,
    });
    const response = await down.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', checks: { db: 'down' } });
    expect((await down.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await down.close();
  });

  it('sends every page with headers that forbid scripts, framing and caching', async () => {
    const response = await app.inject({ method: 'GET', url: '/login' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(response.body).not.toContain('<script');
  });

  it('serves its one stylesheet, which a browser may keep', async () => {
    const response = await app.inject({ method: 'GET', url: '/static/panel.css' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
    expect(response.body).toContain('box-sizing');
  });

  it('answers an unknown address, a body that is not a form and an oversized form politely', async () => {
    const missing = await app.inject({ method: 'GET', url: '/nothing-here' });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain(t('ru', 'pn.notFound'));

    const json = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ t: 'x' }),
    });
    expect(json.statusCode).toBe(415);
    expect(json.body).toContain(t('ru', 'pn.badRequest'));

    const huge = await app.inject({
      method: 'POST',
      url: '/login',
      ...form({ t: 'x'.repeat(20_000) }),
    });
    expect(huge.statusCode).toBe(413);
  });
});

describe('signing in', () => {
  it('shows only a button when the link is opened, so a link preview cannot spend it', async () => {
    const admin = await techAdmin();
    const token = await linkFor(admin);

    for (let visit = 0; visit < 3; visit += 1) {
      const opened = await app.inject({ method: 'GET', url: `/login?t=${token}` });
      expect(opened.statusCode).toBe(200);
      expect(opened.headers['set-cookie']).toBeUndefined();
      expect(opened.body).toContain(`<input type="hidden" name="t" value="${token}" />`);
      expect(opened.body).toContain('<form method="post" action="/login">');
    }
    const response = await app.inject({ method: 'POST', url: '/login', ...form({ t: token }) });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/');
  });

  it('gives a cookie that scripts cannot read, other sites cannot send and http cannot carry', async () => {
    const admin = await techAdmin();
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      ...form({ t: await linkFor(admin) }),
    });
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(
      /^mc_panel=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/,
    );
    // The cookie is the session token itself; the database knows only its hash.
    const value = cookie.split(';')[0]?.split('=')[1] ?? '';
    const [stored] = await sql()<{ dump: string }[]>`
      select row_to_json(s)::text as dump from panel_sessions s where user_id = ${admin.userId}`;
    expect(stored?.dump).not.toContain(value);
  });

  it('leaves Secure and HSTS off only for a panel served over plain http on a developer’s machine', async () => {
    const plain = build({ baseUrl: 'http://localhost:3002' });
    const admin = await techAdmin();
    const response = await plain.inject({
      method: 'POST',
      url: '/login',
      ...form({ t: await linkFor(admin) }),
    });
    expect(String(response.headers['set-cookie'])).toMatch(/Max-Age=43200$/);
    expect(response.headers['strict-transport-security']).toBeUndefined();
    await plain.close();
  });

  it('works once: the same link a second time, a stale one and a made-up one are refused', async () => {
    const admin = await techAdmin();
    const token = await linkFor(admin);
    expect(
      (await app.inject({ method: 'POST', url: '/login', ...form({ t: token }) })).statusCode,
    ).toBe(303);

    const again = await app.inject({ method: 'POST', url: '/login', ...form({ t: token }) });
    expect(again.statusCode).toBe(400);
    expect(again.headers['set-cookie']).toBeUndefined();
    expect(again.body).toContain(t('ru', 'pn.loginFailed'));
    expect(again.body).toContain(t('uz', 'pn.loginFailed'));

    const stale = await linkFor(admin);
    clock = new Date(NOW.getTime() + 5 * 60_000);
    expect(
      (await app.inject({ method: 'POST', url: '/login', ...form({ t: stale }) })).statusCode,
    ).toBe(400);
    clock = NOW;

    for (const forged of ['', 'x', 'A'.repeat(43)]) {
      const response = await app.inject({ method: 'POST', url: '/login', ...form({ t: forged }) });
      expect(response.statusCode, forged).toBe(400);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('does not put into the page a token that does not look like one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/login?t=${encodeURIComponent('"><script>alert(1)</script>')}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('alert(1)');
    expect(response.body).not.toContain('name="t"');
  });

  it('explains how to sign in to anyone without a session, and shows them nothing else', async () => {
    const c = await running();
    const forged = `${SESSION_COOKIE}=${'A'.repeat(43)}`;
    for (const url of [
      '/',
      '/doctors',
      '/clinics',
      '/tech',
      '/tech/incidents',
      '/audit',
      `/clinic/${c.clinicId}`,
      `/clinic/${c.clinicId}/courses`,
      `/clinic/${c.clinicId}/incidents`,
    ]) {
      for (const headers of [{}, { cookie: forged }, { cookie: `${SESSION_COOKIE}=` }]) {
        const response = await app.inject({ method: 'GET', url, headers });
        expect(response.statusCode, url).toBe(401);
        expect(response.body).toContain(t('ru', 'pn.loginHow'));
        expect(response.body).not.toContain('Aziza');
        expect(response.body).not.toContain('Rustam');
        expect(response.body).not.toContain('<nav>');
      }
    }
    const post = await app.inject({
      method: 'POST',
      url: `/doctors/${c.doctorId}/revoke`,
      ...form({ _csrf: 'x' }),
    });
    expect(post.statusCode).toBe(401);
    expect(await doctorStatus(c.doctorId)).toBe('VERIFIED');
  });

  it('ends after twelve hours', async () => {
    const browser = await signIn(await techAdmin());
    clock = new Date(NOW.getTime() + 12 * HOUR - 1);
    expect((await browser.get('/')).statusCode).toBe(200);
    clock = new Date(NOW.getTime() + 12 * HOUR);
    expect((await browser.get('/')).statusCode).toBe(401);
  });

  it('ends when the person signs out, in that browser only', async () => {
    const admin = await techAdmin();
    const browser = await signIn(admin);
    const other = await signIn(admin);

    const left = await browser.post('/logout');

    expect(left.statusCode).toBe(303);
    expect(left.headers.location).toBe('/login');
    expect(String(left.headers['set-cookie'])).toBe(
      'mc_panel=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
    expect((await browser.get('/')).statusCode).toBe(401);
    expect((await other.get('/')).statusCode).toBe(200);
  });

  it('ends at the next request once the role is taken away', async () => {
    const clinicId = await insertClinic(sql());
    const desk = await staffOf(clinicId);
    const browser = await signIn(desk);
    expect((await browser.get(`/clinic/${clinicId}`)).statusCode).toBe(200);

    await sql()`update clinic_staff set status = 'REVOKED' where user_id = ${desk.userId}`;

    expect((await browser.get(`/clinic/${clinicId}`)).statusCode).toBe(401);
    expect((await browser.get('/')).statusCode).toBe(401);
  });

  it('never writes the link or the session into the log: one line per request, path only', async () => {
    const lines: string[] = [];
    const logged = build({ stream: { write: (line) => lines.push(line) } });
    const admin = await techAdmin();
    const token = await linkFor(admin);

    await logged.inject({ method: 'GET', url: `/login?t=${token}` });
    const response = await logged.inject({ method: 'POST', url: '/login', ...form({ t: token }) });
    const cookie = String(response.headers['set-cookie']).split(';')[0] ?? '';
    await logged.inject({ method: 'GET', url: '/audit?type=users', headers: { cookie } });
    await logged.inject({ method: 'GET', url: '/healthz' });
    await logged.close();

    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.map((entry) => [entry.method, entry.path, entry.status])).toEqual([
      ['GET', '/login', 200],
      ['POST', '/login', 303],
      ['GET', '/audit', 200],
    ]);
    const dump = lines.join('');
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(cookie.split('=')[1] ?? 'x');
    expect(dump).not.toContain('type=users');
  });
});

describe('each role sees only its own', () => {
  const techPages = ['/doctors', '/clinics', '/tech', '/tech/incidents', '/audit'];
  const clinicPages = (clinicId: string) => [
    `/clinic/${clinicId}`,
    `/clinic/${clinicId}/courses`,
    `/clinic/${clinicId}/incidents`,
  ];

  it('the front desk: its own clinic, with names and without what was prescribed', async () => {
    const c = await running();
    await missedThree(c);
    const browser = await signIn(await staffOf(c.clinicId));

    const [overview, courses, incidents] = await Promise.all(
      clinicPages(c.clinicId).map((url) => browser.get(url)),
    );

    expect(overview?.statusCode).toBe(200);
    expect(overview?.body).toContain('Test clinic');
    expect(overview?.body).toContain('Tor Rustam');
    expect(overview?.body).toContain(t('ru', 'pn.verification.VERIFIED'));
    expect(courses?.statusCode).toBe(200);
    expect(courses?.body).toContain('Aziza Karimova');
    expect(courses?.body).toContain('Rustam Tor');
    expect(courses?.body).toContain(t('ru', 'status.ACTIVE'));
    // Started at 05:00 on 3 October, on the clock of the person looking.
    expect(courses?.body).toContain('03.10.2026 05:00');
    expect(incidents?.statusCode).toBe(200);
    expect(incidents?.body).toContain(t('ru', 'pn.inc.type.MISS_SERIES'));
    expect(incidents?.body).toContain('Aziza Karimova');
    expect(incidents?.body).toContain('04.10.2026 08:30');
    for (const page of [overview, courses, incidents]) {
      expect(page?.body).not.toContain('Testamol');
      expect(page?.body).not.toContain('MG');
    }
  });

  it('the front desk is refused every page of the technical administrator', async () => {
    const c = await running();
    const browser = await signIn(await staffOf(c.clinicId, 'CLINIC_ADMIN'));

    for (const url of techPages) {
      const response = await browser.get(url);
      expect(response.statusCode, url).toBe(403);
      expect(response.body).toContain(t('ru', 'pn.forbidden'));
      expect(response.body).not.toContain('<table>');
    }
    const home = await browser.get('/');
    expect(home.statusCode).toBe(200);
    for (const url of techPages) {
      expect(home.body, url).not.toContain(`href="${url}"`);
    }
    expect(home.body).toContain(`href="/clinic/${c.clinicId}/courses"`);
    expect(home.body).toContain(t('ru', 'pn.role.CLINIC_ADMIN', { clinic: 'Test clinic' }));
  });

  it('the front desk cannot do what the technical administrator does, even with a valid form', async () => {
    const c = await running();
    const pendingClinic = await insertClinic(sql());
    const pending = await insertClinician(sql(), pendingClinic, { verification: 'PENDING' });
    const desk = await staffOf(c.clinicId, 'CLINIC_ADMIN');
    const browser = await signIn(desk);
    const colleague = await person();
    await repos.incidents.reconcile(system, local(3, '12:00'));
    const [technical] = await sql()<{ id: string }[]>`
      select id from incidents where kind = 'TECHNICAL' and status = 'OPEN' limit 1`;
    const [membership] = await sql()<{ id: string }[]>`
      select id from clinic_staff where user_id = ${desk.userId}`;

    const attempts: [string, Fields][] = [
      [`/doctors/${pending}/verify`, { reference: 'licence 1' }],
      [`/doctors/${c.doctorId}/revoke`, {}],
      [
        `/clinics/${c.clinicId}/staff`,
        { telegramId: String(colleague.telegramUserId), role: 'RECEPTION' },
      ],
      [`/staff/${membership?.id ?? ''}/revoke`, {}],
      [`/tech/incidents/${technical?.id ?? ''}/resolve`, { note: 'x' }],
    ];
    for (const [url, fields] of attempts) {
      const response = await browser.post(url, fields);
      expect(response.statusCode, url).toBe(403);
    }

    expect(await doctorStatus(pending)).toBe('PENDING');
    expect(await doctorStatus(c.doctorId)).toBe('VERIFIED');
    expect(await incidentStatus(technical?.id ?? '')).toBe('OPEN');
    const staff = await sql()<{ status: string }[]>`
      select status from clinic_staff where clinic_id = ${c.clinicId}`;
    expect(staff).toEqual([{ status: 'ACTIVE' }]);
    expect(told).toEqual([]);
  });

  it('the front desk of one clinic gets nothing of another', async () => {
    const mine = await running();
    const other = await running();
    await sql()`update clinics set name = 'Other clinic' where id = ${other.clinicId}`;
    await sql()`
      update patient_profiles set first_name = 'Dilnoza' where user_id = ${other.patientId}`;
    const incidentId = await missedThree(other);
    const browser = await signIn(await staffOf(mine.clinicId));

    for (const url of clinicPages(other.clinicId)) {
      const response = await browser.get(url);
      expect(response.statusCode, url).toBe(403);
      expect(response.body).not.toContain('Dilnoza');
      expect(response.body).not.toContain('Other clinic');
    }
    // A clinic that does not exist looks exactly the same.
    const nowhere = await browser.get('/clinic/00000000-0000-4000-8000-000000000000/courses');
    expect(nowhere.statusCode).toBe(403);
    expect((await browser.get('/clinic/not-an-id/courses')).statusCode).toBe(403);

    const own = await browser.get(`/clinic/${mine.clinicId}/courses`);
    expect(own.body).toContain('Aziza Karimova');
    expect(own.body).not.toContain('Dilnoza');
    expect((await browser.get(`/clinic/${mine.clinicId}/incidents`)).body).not.toContain('Dilnoza');

    // The other clinic's incident cannot be closed through that clinic's address or one's own.
    const direct = await browser.post(`/clinic/${other.clinicId}/incidents/${incidentId}/resolve`, {
      note: 'x',
    });
    expect(direct.statusCode).toBe(403);
    const sideways = await browser.post(
      `/clinic/${mine.clinicId}/incidents/${incidentId}/resolve`,
      { note: 'x' },
    );
    expect(sideways.statusCode).toBe(404);
    expect(await incidentStatus(incidentId)).toBe('OPEN');
  });

  it('the technical administrator: doctors, staff, queues, the trail, and no patient anywhere', async () => {
    const c = await running();
    await missedThree(c);
    await repos.incidents.reconcile(system, local(3, '12:00'));
    const browser = await signIn(await techAdmin());

    for (const url of techPages) {
      const response = await browser.get(url);
      expect(response.statusCode, url).toBe(200);
      for (const secret of ['Aziza', 'Karimova', 'Testamol', c.patientId, c.courseId]) {
        expect(response.body, `${url}: ${secret}`).not.toContain(secret);
      }
    }
    expect((await browser.get('/tech')).body).toContain(t('ru', 'pn.tech.note'));
    expect((await browser.get('/tech')).body).toContain('QUEUED: ');
    const incidents = await browser.get('/tech/incidents');
    expect(incidents.body).toContain(t('ru', 'pn.inc.type.SWEEP_LATE'));
    // The clinic's own incident (a patient who needs a call) is not the administrator's.
    expect(incidents.body).not.toContain(t('ru', 'pn.inc.type.MISS_SERIES'));
    const audit = await browser.get('/audit?type=treatment_courses');
    expect(audit.body).toContain(`treatment_courses ${c.courseId.slice(0, 8)}`);
    expect(audit.body).toContain(`PATIENT ${c.patientId.slice(0, 8)}`);
    expect(audit.body).toContain('START');
  });

  it('the technical administrator is refused every clinic page and cannot close a clinic’s incident', async () => {
    const c = await running();
    const incidentId = await missedThree(c);
    const browser = await signIn(await techAdmin());

    for (const url of clinicPages(c.clinicId)) {
      const response = await browser.get(url);
      expect(response.statusCode, url).toBe(403);
      expect(response.body).not.toContain('Aziza');
      expect(response.body).not.toContain('Rustam');
    }
    const home = await browser.get('/');
    expect(home.body).not.toContain('/clinic/');
    expect(home.body).toContain(t('ru', 'pn.role.TECH_ADMIN'));

    expect(
      (await browser.post(`/clinic/${c.clinicId}/incidents/${incidentId}/resolve`)).statusCode,
    ).toBe(403);
    expect((await browser.post(`/tech/incidents/${incidentId}/resolve`)).statusCode).toBe(404);
    expect(await incidentStatus(incidentId)).toBe('OPEN');
  });

  it('a person who holds both roles gets both, each still within its own bounds', async () => {
    const c = await running();
    const other = await running();
    const both = await staffOf(c.clinicId);
    await repos.platform.grantTechAdmin(system, both.userId);
    const browser = await signIn(both);

    expect((await browser.get('/tech')).statusCode).toBe(200);
    expect((await browser.get(`/clinic/${c.clinicId}/courses`)).body).toContain('Aziza Karimova');
    expect((await browser.get(`/clinic/${other.clinicId}/courses`)).statusCode).toBe(403);
  });

  it('a role taken away while the page is being prepared gets a refusal, not the page', async () => {
    const c = await running();
    const admin = await techAdmin();
    const desk = await staffOf(c.clinicId);
    const adminBrowser = await signIn(admin);
    const deskBrowser = await signIn(desk);
    // The session is read first, the data after it, in a transaction. The role is revoked
    // exactly between the two: whatever opens a transaction finds it already gone.
    const real = testDatabase.db.orm;
    let table = 'platform_staff';
    let userId = admin.userId;
    const revoking = new Proxy(real, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') {
          return value;
        }
        if (property !== 'transaction') {
          return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
        }
        return async (...args: unknown[]): Promise<unknown> => {
          await sql()`
            update ${sql()(table)} set status = 'REVOKED' where user_id = ${userId}`;
          return Reflect.apply(value, target, args) as unknown;
        };
      },
    });
    const racing = buildPanel({
      logger,
      db: testDatabase.db,
      orm: revoking,
      repositoryDeps,
      baseUrl: BASE_URL,
      now: () => clock,
    });

    const tech = await racing.inject({
      method: 'GET',
      url: '/tech',
      headers: { cookie: adminBrowser.cookie },
    });
    table = 'clinic_staff';
    ({ userId } = desk);
    const courses = await racing.inject({
      method: 'GET',
      url: `/clinic/${c.clinicId}/courses`,
      headers: { cookie: deskBrowser.cookie },
    });
    await racing.close();

    for (const response of [tech, courses]) {
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain(t('ru', 'pn.forbidden'));
      expect(response.body).not.toContain('<table>');
      expect(response.body).not.toContain('Aziza');
      expect(response.body).not.toContain('QUEUED');
    }
    expect((await adminBrowser.get('/tech')).statusCode).toBe(401);
  });

  it('a doctor or a patient has no way in at all', async () => {
    const c = await running();
    for (const userId of [c.doctorId, c.patientId]) {
      expect(await repos.panel.issueLogin(system, { userId, now: NOW })).toEqual({
        status: 'NOT_STAFF',
      });
    }
  });
});

describe('forms', () => {
  it('are refused without the token of the session they were sent from', async () => {
    const clinicId = await insertClinic(sql());
    const doctor = await insertClinician(sql(), clinicId, { verification: 'PENDING' });
    const browser = await signIn(await techAdmin());
    const stranger = await signIn(await techAdmin());

    for (const csrf of [null, '', 'x', await stranger.csrf()]) {
      const response = await browser.post(
        `/doctors/${doctor}/verify`,
        { reference: 'licence 7' },
        csrf,
      );
      expect(response.statusCode, String(csrf)).toBe(400);
      expect(response.body).toContain(t('ru', 'pn.badRequest'));
    }
    expect(await doctorStatus(doctor)).toBe('PENDING');
    expect((await browser.post('/logout', {}, null)).statusCode).toBe(400);
    expect((await browser.get('/')).statusCode).toBe(200);

    expect(
      (await browser.post(`/doctors/${doctor}/verify`, { reference: 'licence 7' })).statusCode,
    ).toBe(303);
    expect(await doctorStatus(doctor)).toBe('VERIFIED');
  });

  it('are refused without that token at every address that changes something', async () => {
    const c = await running();
    const incidentId = await missedThree(c);
    const both = await staffOf(c.clinicId, 'CLINIC_ADMIN');
    await repos.platform.grantTechAdmin(system, both.userId);
    const browser = await signIn(both);
    const [membership] = await sql()<{ id: string }[]>`
      select id from clinic_staff where user_id = ${both.userId}`;

    for (const url of [
      `/doctors/${c.doctorId}/revoke`,
      `/doctors/${c.doctorId}/verify`,
      `/clinics/${c.clinicId}/staff`,
      `/staff/${membership?.id ?? ''}/revoke`,
      `/tech/incidents/${incidentId}/resolve`,
      `/clinic/${c.clinicId}/incidents/${incidentId}/resolve`,
      '/logout',
    ]) {
      const response = await browser.post(
        url,
        { reference: 'x', note: 'x', telegramId: String(both.telegramUserId), role: 'RECEPTION' },
        null,
      );
      expect(response.statusCode, url).toBe(400);
    }
    expect(await doctorStatus(c.doctorId)).toBe('VERIFIED');
    expect(await incidentStatus(incidentId)).toBe('OPEN');
    expect((await browser.get(`/clinic/${c.clinicId}`)).statusCode).toBe(200);
  });

  it('say what happened only in words from a fixed list', async () => {
    const browser = await signIn(await techAdmin());

    expect((await browser.get('/?ok=verified')).body).toContain(t('ru', 'pn.doctors.verifiedDone'));
    expect((await browser.get('/?problem=reference')).body).toContain(
      t('ru', 'pn.doctors.referenceRequired'),
    );
    for (const value of ['%3Cscript%3Ealert(1)%3C/script%3E', 'toString', 'constructor', '']) {
      const response = await browser.get(`/?ok=${value}&problem=${value}`);
      expect(response.statusCode, value).toBe(200);
      expect(response.body).not.toContain('class="notice');
      expect(response.body).not.toContain('alert(1)');
    }
  });

  it('show whatever a person typed as text, never as markup', async () => {
    const clinicId = await insertClinic(sql(), { name: '<script>alert("c")</script>' });
    const doctor = await insertClinician(sql(), clinicId, {
      verification: 'PENDING',
      firstName: '<img src=x onerror=alert(1)>',
    });
    await sql()`
      update clinician_profiles set applicant_note = ${'"><b>note</b>'} where user_id = ${doctor}`;
    const admin = await person('<i>Tech</i>', "O'Admin");
    await repos.platform.grantTechAdmin(system, admin.userId);
    const browser = await signIn(admin);

    const doctors = await browser.get('/doctors');
    const clinics = await browser.get('/clinics');

    expect(doctors.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(doctors.body).toContain('&quot;&gt;&lt;b&gt;note&lt;/b&gt;');
    expect(doctors.body).toContain('&lt;i&gt;Tech&lt;/i&gt; O&#39;Admin');
    expect(clinics.body).toContain('&lt;script&gt;alert(&quot;c&quot;)&lt;/script&gt;');
    for (const page of [doctors, clinics]) {
      expect(page.body).not.toContain('<script');
      expect(page.body).not.toContain('<img');
      expect(page.body).not.toContain('<b>');
      expect(page.body).not.toContain('<i>');
    }
  });

  it('are in the language the person chose in the bot', async () => {
    const admin = await techAdmin();
    await sql()`update users set locale = 'uz' where id = ${admin.userId}`;
    const browser = await signIn(admin);

    const page = await browser.get('/tech');

    expect(page.body).toContain('<html lang="uz">');
    expect(page.body).toContain(t('uz', 'pn.nav.tech'));
    expect(page.body).toContain(t('uz', 'pn.signOut'));
    expect(page.body).not.toContain(t('ru', 'pn.signOut'));
  });
});

describe('what a technical administrator does', () => {
  it('verifies a doctor, saying what was checked, and the doctor is told in the bot', async () => {
    const clinicId = await insertClinic(sql());
    telegramId += 1;
    const doctorTelegramId = telegramId;
    const doctor = await insertClinician(sql(), clinicId, {
      verification: 'PENDING',
      firstName: 'Nodira',
      telegramId: doctorTelegramId,
    });
    const admin = await techAdmin();
    const browser = await signIn(admin);

    const listed = await browser.get('/doctors');
    expect(listed.body).toContain('Tor Nodira');
    expect(listed.body).toContain(String(doctorTelegramId));
    expect(listed.body).toContain(`action="/doctors/${doctor}/verify"`);

    for (const reference of ['', '   ', 'я'.repeat(501)]) {
      const refused = await browser.post(`/doctors/${doctor}/verify`, { reference });
      expect(refused.statusCode).toBe(303);
      expect(refused.headers.location).toBe('/doctors?problem=reference');
    }
    expect(await doctorStatus(doctor)).toBe('PENDING');
    expect(told).toEqual([]);

    const done = await browser.post(`/doctors/${doctor}/verify`, { reference: ' licence 12345 ' });

    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe('/doctors?ok=verified');
    const [stored] = await sql()<
      { verification_status: string; verification_reference: string; verified_by: string }[]
    >`select verification_status, verification_reference, verified_by
      from clinician_profiles where user_id = ${doctor}`;
    expect(stored).toEqual({
      verification_status: 'VERIFIED',
      verification_reference: 'licence 12345',
      verified_by: admin.userId,
    });
    expect(told).toEqual([[doctorTelegramId, t('ru', 'doctor.verified')]]);
    expect((await browser.get('/doctors')).body).toContain(`action="/doctors/${doctor}/revoke"`);

    // Pressed twice: nothing changes and the doctor is not told again.
    await browser.post(`/doctors/${doctor}/verify`, { reference: 'licence 12345' });
    expect(told).toHaveLength(1);
  });

  it('verifies even when the doctor cannot be told', async () => {
    const clinicId = await insertClinic(sql());
    const doctor = await insertClinician(sql(), clinicId, { verification: 'PENDING' });
    const browser = await signIn(await techAdmin());
    failNotify = true;

    const done = await browser.post(`/doctors/${doctor}/verify`, { reference: 'licence 1' });

    expect(done.headers.location).toBe('/doctors?ok=verified');
    expect(await doctorStatus(doctor)).toBe('VERIFIED');
  });

  it('withdraws a doctor’s standing, and answers 404 for a doctor that does not exist', async () => {
    const c = await running();
    const browser = await signIn(await techAdmin());

    const done = await browser.post(`/doctors/${c.doctorId}/revoke`);
    expect(done.headers.location).toBe('/doctors?ok=revoked');
    expect(await doctorStatus(c.doctorId)).toBe('REVOKED');
    expect(told).toEqual([]);

    for (const url of [
      '/doctors/00000000-0000-4000-8000-000000000000/revoke',
      '/doctors/00000000-0000-4000-8000-000000000000/verify',
      '/doctors/not-an-id/revoke',
      `/doctors/${c.doctorId}/promote`,
    ]) {
      expect((await browser.post(url, { reference: 'x' })).statusCode, url).toBe(404);
    }
  });

  it('appoints a clinic’s staff by Telegram id and takes the role away again', async () => {
    const clinicId = await insertClinic(sql(), { name: 'Nur Clinic' });
    const who = await person('Malika', 'Usmanova');
    const browser = await signIn(await techAdmin());

    const refusals: Fields[] = [
      { telegramId: '999999999', role: 'RECEPTION' },
      { telegramId: 'abc', role: 'RECEPTION' },
      { telegramId: `${String(who.telegramUserId)} or 1=1`, role: 'RECEPTION' },
      { telegramId: String(who.telegramUserId), role: 'TECH_ADMIN' },
    ];
    for (const fields of refusals) {
      const refused = await browser.post(`/clinics/${clinicId}/staff`, fields);
      expect(refused.headers.location, JSON.stringify(fields)).toBe(
        '/clinics?problem=staffNotFound',
      );
    }
    expect(
      (
        await browser.post('/clinics/not-an-id/staff', {
          telegramId: String(who.telegramUserId),
          role: 'RECEPTION',
        })
      ).headers.location,
    ).toBe('/clinics?problem=staffNotFound');
    expect(await repos.panel.issueLogin(system, { userId: who.userId, now: NOW })).toEqual({
      status: 'NOT_STAFF',
    });

    const added = await browser.post(`/clinics/${clinicId}/staff`, {
      telegramId: String(who.telegramUserId),
      role: 'RECEPTION',
    });
    expect(added.headers.location).toBe('/clinics?ok=staffAdded');
    const page = await browser.get('/clinics');
    expect(page.body).toContain('Nur Clinic');
    expect(page.body).toContain('Usmanova Malika');

    const desk = await signIn(who);
    expect((await desk.get(`/clinic/${clinicId}`)).statusCode).toBe(200);
    const [membership] = await sql()<{ id: string; role: string }[]>`
      select id, role from clinic_staff where user_id = ${who.userId}`;
    expect(membership?.role).toBe('RECEPTION');

    const revoked = await browser.post(`/staff/${membership?.id ?? ''}/revoke`);
    expect(revoked.headers.location).toBe('/clinics?ok=staffRevoked');
    expect((await desk.get(`/clinic/${clinicId}`)).statusCode).toBe(401);
    expect((await browser.post('/staff/not-an-id/revoke')).statusCode).toBe(404);
    // Already revoked: there is nothing to take away.
    expect((await browser.post(`/staff/${membership?.id ?? ''}/revoke`)).statusCode).toBe(404);
  });

  it('closes an incident about the service itself', async () => {
    await repos.incidents.reconcile(system, local(4, '12:00'));
    const c = await running();
    await repos.incidents.reconcile(system, local(5, '12:00'));
    const [incident] = await sql()<{ id: string }[]>`
      select id from incidents where kind = 'TECHNICAL' and status = 'OPEN'
      order by opened_at desc limit 1`;
    const browser = await signIn(await techAdmin());
    expect((await browser.get('/tech/incidents')).body).toContain(
      `action="/tech/incidents/${incident?.id ?? ''}/resolve"`,
    );

    const done = await browser.post(`/tech/incidents/${incident?.id ?? ''}/resolve`, {
      note: 'воркер перезапущен',
    });

    expect(done.headers.location).toBe('/tech/incidents?ok=resolved');
    expect(await incidentStatus(incident?.id ?? '')).toBe('RESOLVED');
    const page = await browser.get('/tech/incidents');
    expect(page.body).toContain('воркер перезапущен');
    expect(page.body).not.toContain(c.courseId);
  });

  it('pages through the audit trail and filters it by the kind of record', async () => {
    await running();
    const browser = await signIn(await techAdmin());

    const first = await browser.get('/audit');
    const older = /href="\/audit\?before=(\d+)"/.exec(first.body)?.[1];
    expect(older).toBeDefined();
    const next = await browser.get(`/audit?before=${older ?? ''}`);
    expect(next.statusCode).toBe(200);
    expect(next.body).not.toBe(first.body);

    const filtered = await browser.get('/audit?type=clinic_staff');
    expect(filtered.body).toContain('clinic_staff ');
    expect(filtered.body).not.toContain('treatment_courses ');
    expect(filtered.body).toContain('value="clinic_staff"');
    // A filter that is not a table name is ignored rather than echoed.
    const odd = await browser.get(`/audit?type=${encodeURIComponent('"><b>')}&before=-1`);
    expect(odd.statusCode).toBe(200);
    expect(odd.body).toContain('value=""');
  });
});

describe('what a clinic’s staff do', () => {
  it('close an incident with a note of what the call achieved', async () => {
    const c = await running();
    const incidentId = await missedThree(c);
    const desk = await staffOf(c.clinicId);
    const browser = await signIn(desk);
    const base = `/clinic/${c.clinicId}/incidents`;
    expect((await browser.get(base)).body).toContain(`action="${base}/${incidentId}/resolve"`);

    const long = await browser.post(`${base}/${incidentId}/resolve`, { note: 'я'.repeat(501) });
    expect(long.headers.location).toBe(`${base}?problem=noteTooLong`);
    expect(await incidentStatus(incidentId)).toBe('OPEN');

    const done = await browser.post(`${base}/${incidentId}/resolve`, {
      note: 'Позвонили: <в отъезде> до пятницы',
    });

    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe(`${base}?ok=resolved`);
    const [stored] = await sql()<{ status: string; resolved_by: string; resolved_at: Date }[]>`
      select status, resolved_by, resolved_at from incidents where id = ${incidentId}`;
    expect(stored).toEqual({ status: 'RESOLVED', resolved_by: desk.userId, resolved_at: NOW });
    const page = await browser.get(base);
    expect(page.body).toContain('Позвонили: &lt;в отъезде&gt; до пятницы');
    expect(page.body).not.toContain(`${incidentId}/resolve`);

    // Closed is closed.
    expect((await browser.post(`${base}/${incidentId}/resolve`, { note: 'ещё' })).statusCode).toBe(
      404,
    );
    expect((await browser.post(`${base}/not-an-id/resolve`)).statusCode).toBe(404);
  });

  it('see a patient the clinic no longer treats without the name', async () => {
    const c = await running();
    await missedThree(c);
    const browser = await signIn(await staffOf(c.clinicId));
    await sql()`
      update care_relationships set status = 'ENDED', ended_at = now()
      where id = ${c.relationshipId}`;

    for (const url of [`/clinic/${c.clinicId}/courses`, `/clinic/${c.clinicId}/incidents`]) {
      const page = await browser.get(url);
      expect(page.statusCode).toBe(200);
      expect(page.body, url).toContain(t('ru', 'pn.inc.nameHidden'));
      expect(page.body).not.toContain('Aziza');
    }
  });

  it('leave a trace each time they look at who is being treated', async () => {
    const c = await running();
    const desk = await staffOf(c.clinicId);
    const browser = await signIn(desk);

    await browser.get(`/clinic/${c.clinicId}/courses`);

    const rows = await sql()<{ entity_type: string; request_id: string | null }[]>`
      select entity_type, request_id from audit_log
      where actor_user_id = ${desk.userId} and action = 'READ'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity_type).toBe('treatment_courses');
    expect(rows[0]?.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
