/* Demo data: the same API answered in memory (mirrors apps/ios DemoBackend.swift). */
(function () {
  const ZONE = 'Asia/Tashkent';
  const MIN = 60000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  const meds = {
    amox: { id: 'm-amox', name: 'Amoksiklav', value: 625, unit: 'MG', food: 'AFTER_MEAL', times: ['08:00', '14:00', '20:00'], instructions: 'Запивать стаканом воды' },
    vitD: { id: 'm-vitd', name: 'Vitamin D3', value: 2000, unit: 'IU', food: 'WITH_MEAL', times: ['08:00'] },
    ibu: { id: 'm-ibu', name: 'Ibuprofen', value: 400, unit: 'MG', food: 'AFTER_MEAL', times: [], prn: true, max: 3, interval: 360 },
    mg: { id: 'm-mg', name: 'Magniy B6', value: 1, unit: 'TABLET', food: 'WITH_MEAL', times: ['13:00'] },
    omez: { id: 'm-omez', name: 'Omeprazol', value: 20, unit: 'MG', food: 'BEFORE_MEAL', times: ['07:30'] },
    azi: { id: 'm-azi', name: 'Azitromitsin', value: 500, unit: 'MG', food: 'BEFORE_MEAL', times: ['09:00'] },
  };

  /** Local wall-clock time in Tashkent (UTC+5, no DST) as a Date. */
  function at(h, m, dayOffset, now) {
    const local = new Date(now.getTime() + 5 * HOUR);
    const utc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (dayOffset || 0), h - 5, m);
    return new Date(utc);
  }
  function localDate(d) {
    const l = new Date(d.getTime() + 5 * HOUR);
    return l.toISOString().slice(0, 10);
  }
  const iso = (d) => (d ? d.toISOString() : null);

  let state;
  function reset(now) {
    now = now || new Date();
    const plan = [[8, 0, meds.amox], [8, 0, meds.vitD], [14, 0, meds.amox], [20, 0, meds.amox]];
    const doses = plan.map(([h, m, med], i) => {
      const scheduledAt = at(h, m, 0, now);
      const d = { id: 'd' + (i + 1), med, scheduledAt, status: 'SCHEDULED', answeredAt: null, skipReason: null, snoozedUntil: null };
      const deadline = new Date(scheduledAt.getTime() + 30 * MIN);
      if (now > deadline) {
        if (med === meds.vitD) { d.status = 'SKIPPED'; d.skipReason = 'FORGOT'; } else d.status = 'TAKEN';
        d.answeredAt = new Date(scheduledAt.getTime() + 4 * MIN);
      } else if (now >= scheduledAt) d.status = 'NOTIFIED';
      return d;
    });
    // A dose two minutes from now, so the alarm can be seen ringing right away.
    const soon = new Date(Math.ceil((now.getTime() + 2 * MIN) / MIN) * MIN);
    doses.push({ id: 'd-soon', med: meds.mg, scheduledAt: soon, status: 'SCHEDULED', answeredAt: null, skipReason: null, snoozedUntil: null });
    state = { doses, pendingStartedAt: null, changePending: true, prn: [new Date(now.getTime() - 5 * HOUR)], locale: 'ru' };
  }

  function doseJson(d, now) {
    const open = ['SCHEDULED', 'NOTIFIED', 'SNOOZED'].includes(d.status);
    return {
      id: d.id, courseId: 'c-active', timezone: ZONE,
      scheduledAt: iso(d.scheduledAt), deadlineAt: iso(new Date(d.scheduledAt.getTime() + 30 * MIN)),
      status: d.status, answeredAt: iso(d.answeredAt),
      correctableUntil: d.answeredAt ? iso(new Date(d.answeredAt.getTime() + HOUR)) : null,
      skipReason: d.skipReason, snoozedUntil: iso(d.snoozedUntil),
      snoozeOptions: open ? [5, 10, 15] : [], canAnswer: open || d.status === 'MISSED',
      medication: { displayName: d.med.name, doseValue: d.med.value, doseDisplay: null, doseUnit: d.med.unit, foodRule: d.med.food },
    };
  }
  function medJson(m) {
    return { id: m.id, lineId: m.id, displayName: m.name, doseValue: m.value, doseDisplay: null, doseUnit: m.unit, foodRule: m.food,
      instructions: m.instructions || null, asNeeded: !!m.prn, maxDailyDoses: m.max || null, minimumIntervalMinutes: m.interval || null,
      activeFromDay: 1, activeToDay: 10, times: m.times };
  }
  function adh(t, l, s, m) {
    const o = t + l + s + m;
    return { taken: t, takenLate: l, skipped: s, missed: m, occurred: o, percent: o ? Math.round((t / o) * 1000) / 10 : null };
  }
  function prnItem(now) {
    const recent = state.prn.filter((p) => now - p < DAY);
    const last = recent[recent.length - 1] || null;
    return { medicationId: meds.ibu.id, courseId: 'c-active', timezone: ZONE, displayName: meds.ibu.name, doseValue: 400, doseDisplay: null,
      doseUnit: 'MG', foodRule: 'AFTER_MEAL', maxDailyDoses: 3, minimumIntervalMinutes: 360, takenInDay: recent.length,
      lastTakenAt: iso(last), undoable: last && now - last < HOUR ? { eventId: 'e1', until: iso(new Date(last.getTime() + HOUR)) } : null,
      overLimit: recent.length >= 3, withinLimitsFrom: iso(now) };
  }
  function course(id, now) {
    if (id === 'c-active') return { id, status: 'ACTIVE', timezone: ZONE, durationDays: 10, startedAt: iso(new Date(now - 2 * DAY)),
      firstDay: localDate(new Date(now - 2 * DAY)), endedAt: null, sentAt: iso(new Date(now - 5 * DAY)),
      startWindowTo: null, doctor: { firstName: 'Rustam', lastName: 'Tursunov' },
      medications: [meds.amox, meds.vitD, meds.ibu].map(medJson), pauses: [], changePending: state.changePending, adherence: adh(6, 1, 1, 0) };
    if (id === 'c-pending') { const s = state.pendingStartedAt; return { id, status: s ? 'ACTIVE' : 'PENDING_PATIENT', timezone: ZONE, durationDays: 14,
      startedAt: iso(s), firstDay: s ? localDate(s) : null, endedAt: null, sentAt: iso(new Date(now - DAY)),
      startWindowTo: iso(new Date(now.getTime() + 6 * DAY)), doctor: { firstName: 'Dilnoza', lastName: 'Karimova' },
      medications: [medJson(meds.omez)], pauses: [], changePending: false, adherence: s ? adh(0, 0, 0, 0) : null }; }
    return { id: 'c-past', status: 'COMPLETED', timezone: ZONE, durationDays: 7, startedAt: iso(new Date(now - 40 * DAY)),
      firstDay: localDate(new Date(now - 40 * DAY)), endedAt: iso(new Date(now - 33 * DAY)), sentAt: iso(new Date(now - 42 * DAY)),
      startWindowTo: null, doctor: { firstName: 'Dilnoza', lastName: 'Karimova' }, medications: [medJson(meds.azi)], pauses: [],
      changePending: false, adherence: adh(6, 0, 1, 0) };
  }
  function report(id) {
    if (id === 'c-active') return { byMedication: [{ lineId: 'm-amox', displayName: 'Amoksiklav', adherence: adh(5, 1, 0, 0) },
      { lineId: 'm-vitd', displayName: 'Vitamin D3', adherence: adh(1, 0, 1, 0) }], skipReasons: { FORGOT: 1, NO_MEDICATION: 0, OTHER: 0 } };
    if (id === 'c-past') return { byMedication: [{ lineId: 'm-azi', displayName: 'Azitromitsin', adherence: adh(6, 0, 1, 0) }],
      skipReasons: { FORGOT: 0, NO_MEDICATION: 1, OTHER: 0 } };
    return null;
  }
  function days(id, now) {
    const rows = id === 'c-active' ? [[meds.amox, 8, 'TAKEN'], [meds.vitD, 8, 'TAKEN'], [meds.amox, 14, 'TAKEN_LATE'], [meds.amox, 20, 'TAKEN']]
      : id === 'c-past' ? [[meds.azi, 9, 'TAKEN']] : [];
    const out = [];
    if (rows.length) for (let o = 1; o <= 2; o++) out.push({ date: localDate(new Date(now - o * DAY)), entries: rows.map(([m, h, s], i) => ({
      at: iso(at(h, 0, -o, now)), displayName: m.name, doseValue: m.value, doseUnit: m.unit, doseDisplay: null,
      status: o === 2 && i === 1 ? 'SKIPPED' : s, skipReason: o === 2 && i === 1 ? 'FORGOT' : null })) });
    return { page: 1, pages: 1, days: out };
  }

  function answer(id, action, body, now) {
    const d = state.doses.find((x) => x.id === id);
    if (!d) return [404, { error: 'not_found' }];
    const open = ['SCHEDULED', 'NOTIFIED', 'SNOOZED'].includes(d.status);
    const deadline = new Date(d.scheduledAt.getTime() + 30 * MIN);
    if (action === 'take') {
      if (!open && d.status !== 'MISSED') return [200, { result: 'ALREADY', dose: doseJson(d, now) }];
      if (now < d.scheduledAt.getTime() - HOUR) return [409, { error: 'too_early', dose: doseJson(d, now) }];
      d.status = now > deadline ? 'TAKEN_LATE' : 'TAKEN'; d.answeredAt = now; d.snoozedUntil = null;
    } else if (action === 'skip') {
      if (!open) return [200, { result: 'ALREADY', dose: doseJson(d, now) }];
      d.status = 'SKIPPED'; d.skipReason = body.reason || 'OTHER'; d.answeredAt = now; d.snoozedUntil = null;
    } else if (action === 'snooze') {
      if (!open) return [409, { error: 'snooze_not_allowed', dose: doseJson(d, now) }];
      d.status = 'SNOOZED'; d.snoozedUntil = new Date(now.getTime() + (body.minutes || 10) * MIN);
    } else if (action === 'undo') {
      if (!d.answeredAt || now - d.answeredAt > HOUR) return [409, { error: 'not_correctable', dose: doseJson(d, now) }];
      d.status = now > deadline ? 'MISSED' : now >= d.scheduledAt ? 'NOTIFIED' : 'SCHEDULED'; d.answeredAt = null; d.skipReason = null;
    } else return [404, { error: 'not_found' }];
    return [200, { result: 'DONE', dose: doseJson(d, now) }];
  }

  function respond(method, path, body) {
    const now = new Date();
    if (!state) reset(now);
    const p = path.split('?')[0].split('/').filter(Boolean).slice(1);
    const [a, b, c] = p;
    const me = () => ({ id: 'demo', firstName: 'Farhod', lastName: 'Demo', locale: state.locale, timezone: ZONE, consent: 'GRANTED', deletionDueAt: null });
    if (a === 'me' && !b) { if (method === 'PATCH' && body.locale) state.locale = body.locale; return [200, me()]; }
    if (a === 'today') return [200, { doses: state.doses.slice().sort((x, y) => x.scheduledAt - y.scheduledAt).map((d) => doseJson(d, now)), asNeeded: [prnItem(now)] }];
    if (a === 'courses' && !b) return [200, { courses: ['c-active', 'c-pending', 'c-past'].map((id) => course(id, now)) }];
    if (a === 'courses' && b && !c) return [200, Object.assign(course(b, now), { report: report(b) })];
    if (a === 'courses' && c === 'start' && method === 'GET') return [200, b === 'c-pending' && !state.pendingStartedAt
      ? { canStart: true, outlook: { firstDay: localDate(now), lastDay: localDate(new Date(now.getTime() + 13 * DAY)), dosesToday: 0, plannedPerDay: 1, dosesTotal: 13, firstDoseAt: iso(at(7, 30, 1, now)) } }
      : { canStart: false, refusal: 'ALREADY_STARTED' }];
    if (a === 'courses' && c === 'start') { if (state.pendingStartedAt) return [409, { error: 'already_started' }]; state.pendingStartedAt = now; return [200, { course: course(b, now) }]; }
    if (a === 'courses' && c === 'change' && method === 'GET') return [200, { change: b === 'c-active' && state.changePending
      ? { medications: [meds.amox, meds.vitD, meds.ibu, meds.mg].map(medJson), added: [medJson(meds.mg)], removed: [] } : null }];
    if (a === 'courses' && c === 'change') { if (!state.changePending) return [409, { error: 'nothing_pending' }]; state.changePending = false; return [200, { course: course(b, now) }]; }
    if (a === 'courses' && c === 'pause-request') return [200, { status: 'requested' }];
    if (a === 'courses' && c === 'days') return [200, days(b, now)];
    if (a === 'doses' && c) return answer(b, c, body, now);
    if (a === 'prn' && b === 'events') { if (!state.prn.length) return [409, { error: 'not_correctable' }]; state.prn.pop(); return [200, { result: 'UNDONE', item: prnItem(now) }]; }
    if (a === 'prn') { state.prn.push(now); return [200, { result: 'RECORDED', overLimit: state.prn.filter((x) => now - x < DAY).length > 3, item: prnItem(now) }]; }
    if (a === 'privacy' && !b) return [200, { consent: { version: '2026-10-v1', at: iso(new Date(now - 40 * DAY)) }, decision: 'GRANTED', deletionDueAt: null,
      doctors: [{ relationshipId: 'r1', firstName: 'Rustam', lastName: 'Tursunov', status: 'ACTIVE', sharesHistory: true },
        { relationshipId: 'r2', firstName: 'Dilnoza', lastName: 'Karimova', status: 'ACTIVE', sharesHistory: false }] }];
    if (a === 'privacy') return [200, { ok: true }];
    return [404, { error: 'not_found' }];
  }

  window.Demo = { respond, reset };
})();
