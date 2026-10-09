/* Alcore web app: same screens as the iOS app, plus an alarm that plays a melody when a dose is due. */
(function () {
  'use strict';

  // ---------- Texts ----------
  const T = {
    ru: {
      'app.name': 'Alcore', 'signin.title': 'Ваш курс лечения — под рукой',
      'signin.subtitle': 'Приёмы на сегодня, курс от врача и история — в одном месте.',
      'signin.button': 'Войти через Telegram', 'signin.soon': 'Вход через Telegram заработает, когда подключим сервер. Пока — демо.',
      'signin.demo': 'Посмотреть без входа',
      'signin.h1a': 'Лекарства', 'signin.h1b': 'вовремя.', 'hero.done': 'Всё на сегодня', 'hero.good': 'Хорошо идёте', 'hero.start': 'Начнём день', 'hero.subDone': 'Все приёмы отмечены. Отдыхайте — завтра напомним снова.', 'hero.subNext': 'Следующий приём — {name} в {time}. Мы напомним мелодией.', 'hero.subNone': 'Когда врач пришлёт курс, приёмы появятся здесь.', 'hero.label': 'Приёмы сегодня', 'st.ontime': 'Вовремя', 'st.course': 'Курс', 'st.day': 'День', 'sec.doses': 'Приёмы', 'sec.prn': 'По необходимости', 'today.cta': 'Подробнее о курсе', 'stat.next': 'Следующий', 'signin.lead': 'Курс от врача, приёмы на сегодня и будильник, который не даст забыть.', 'alarm.live': 'Приём сейчас', 'today.done': 'принято',
      'tab.today': 'Сегодня', 'tab.courses': 'Курсы', 'tab.settings': 'Профиль',
      'g.morning': 'Доброе утро', 'g.day': 'Добрый день', 'g.evening': 'Добрый вечер',
      'today.progress': '{a} из {b} приёмов', 'today.allDone': 'Все приёмы на сегодня отмечены', 'today.next': 'Следующий',
      'today.asNeeded': 'По необходимости', 'today.empty': 'На сегодня приёмов нет',
      'take': 'Выпил(а)', 'takeLate': 'Всё-таки выпил(а)', 'skip': 'Пропустить', 'later': 'Позже', 'undo': 'Отменить',
      'laterN': 'Через {n} мин', 'cancel': 'Отмена', 'close': 'Закрыть',
      'skip.title': 'Почему пропускаете?', 'skip.note': 'Своими словами (необязательно)', 'skip.send': 'Пропустить приём',
      'r.FORGOT': 'Забыл(а)', 'r.NO_MEDICATION': 'Нет лекарства', 'r.OTHER': 'Другая причина',
      'prn.take': 'Принял(а)', 'prn.count': 'За сутки: {a} из {b}', 'prn.over': 'Это сверх назначенного. Врач получит уведомление.', 'prn.undo': 'Отменить отметку',
      's.SCHEDULED': 'Ожидает', 's.NOTIFIED': 'Пора принять', 's.SNOOZED': 'Отложен', 's.TAKEN': 'Принят', 's.TAKEN_LATE': 'Принят с опозданием',
      's.SKIPPED': 'Пропущен', 's.MISSED': 'Не отмечен', 's.SUPERSEDED': 'Отменён', 'snoozedTo': 'до {t}',
      'courses.current': 'Текущие', 'courses.past': 'Прошлые', 'course.from': 'Курс от {d}', 'course.days': '{n} дн.', 'course.day': 'День {a} из {b}',
      'cs.PENDING_PATIENT': 'Ждёт начала', 'cs.ACTIVE': 'Идёт', 'cs.PAUSED': 'На паузе', 'cs.COMPLETED': 'Завершён', 'cs.CANCELLED': 'Отменён',
      'course.adherence': 'Вовремя', 'course.taken': 'Принято', 'course.late': 'С опозданием', 'course.skipped': 'Пропущено', 'course.missed': 'Не отмечено',
      'course.meds': 'Препараты', 'course.history': 'История по дням', 'course.start': 'Начать курс', 'course.startBy': 'Начать до {d}',
      'course.startConfirm': 'Начать курс сегодня?', 'course.startDetails': 'День 1 — {a}, последний день — {b}. Всего приёмов: {n}.',
      'course.started': 'Курс начат', 'course.change': 'Врач изменил план', 'course.changeText': 'Новый план начнёт действовать после вашего согласия.',
      'course.changeAccept': 'Принять новый план', 'course.added': 'Добавлено', 'course.removed': 'Убрано', 'course.changeDone': 'Новый план действует',
      'course.pause': 'Попросить врача о паузе', 'course.pauseText': 'Врач получит вашу просьбу. Не прекращайте приём сами, пока врач не ответит.',
      'course.pauseSent': 'Просьба отправлена врачу', 'course.asNeeded': 'по необходимости, до {n} раз в сутки', 'course.instr': 'Указания врача',
      'f.BEFORE_MEAL': 'до еды', 'f.WITH_MEAL': 'во время еды', 'f.AFTER_MEAL': 'после еды', 'f.ANY': 'независимо от еды',
      'u.MG': 'мг', 'u.G': 'г', 'u.MCG': 'мкг', 'u.ML': 'мл', 'u.TABLET': 'табл.', 'u.CAPSULE': 'капс.', 'u.DROP': 'кап.', 'u.IU': 'МЕ', 'u.PUFF': 'вдох', 'u.SACHET': 'саше', 'u.OTHER': 'ед.',
      'history.prn': 'по необходимости',
      'set.language': 'Язык', 'set.alarm': 'Будильник', 'set.alarmOn': 'Мелодия при наступлении приёма', 'set.alarmTest': 'Проверить звук',
      'set.alarmNote': 'Звенит, пока приложение открыто. На закрытом или заблокированном телефоне веб-версия звонить не может — для этого есть напоминания в Telegram.',
      'set.melody': 'Мелодия', 'set.theme': 'Оформление', 'set.dark': 'Тёмная тема', 'set.theme': 'Оформление', 'th.night': 'Ночь', 'th.mint': 'Мята', 'th.dusk': 'Закат', 'mel.soft': 'Мягкая', 'mel.classic': 'Классика', 'mel.bright': 'Звонкая',
      'set.install': 'Установить на экран «Домой»', 'set.installText': 'В Safari нажмите «Поделиться» внизу, затем «На экран Домой».',
      'set.privacy': 'Согласие и данные', 'set.logout': 'Выйти', 'set.logoutText': 'Выйти из демо и вернуться ко входу?',
      'demo.badge': 'Демо', 'demo.banner': 'Демо-режим: данные ненастоящие, ничего никуда не отправляется.',
      'privacy.consent': 'Согласие дано {d}', 'privacy.doctors': 'Мои врачи', 'privacy.withdraw': 'Отозвать согласие', 'privacy.delete': 'Удалить мои данные',
      'privacy.demo': 'В демо эти действия ничего не меняют.',
      'alarm.title': 'Пора принять', 'alarm.enable': 'Включить будильник', 'alarm.enableText': 'Нажмите, чтобы разрешить звук: браузер не даёт играть музыку без вашего касания.',
      'alarm.on': 'Будильник включён', 'alarm.off': 'Будильник выключен',
      'err.too_early': 'Слишком рано: отметить можно не раньше чем за час до приёма.', 'err.not_correctable': 'Изменить ответ уже нельзя: прошёл час.',
      'err.generic': 'Что-то пошло не так. Попробуйте ещё раз.',
    },
    uz: {
      'app.name': 'Alcore', 'signin.title': 'Davolash kursingiz — qoʻl ostida',
      'signin.subtitle': 'Bugungi qabullar, shifokor kursi va tarix — bir joyda.',
      'signin.button': 'Telegram orqali kirish', 'signin.soon': 'Telegram orqali kirish server ulanganda ishlaydi. Hozircha — demo.',
      'signin.demo': 'Kirmasdan koʻrish',
      'signin.h1a': 'Dorilar', 'signin.h1b': 'oʻz vaqtida.', 'hero.done': 'Bugungisi tayyor', 'hero.good': 'Yaxshi ketyapsiz', 'hero.start': 'Kunni boshlaymiz', 'hero.subDone': 'Barcha qabullar belgilandi. Dam oling — ertaga yana eslatamiz.', 'hero.subNext': 'Keyingi qabul — {name}, {time} da. Kuy bilan eslatamiz.', 'hero.subNone': 'Shifokor kurs yuborganda qabullar shu yerda paydo boʻladi.', 'hero.label': 'Bugungi qabullar', 'st.ontime': 'Oʻz vaqtida', 'st.course': 'Kurs', 'st.day': 'Kun', 'sec.doses': 'Qabullar', 'sec.prn': 'Zaruratga qarab', 'today.cta': 'Kurs haqida batafsil', 'stat.next': 'Keyingisi', 'signin.lead': 'Shifokor kursi, bugungi qabullar va unutishga qoʻymaydigan budilnik.', 'alarm.live': 'Hozir qabul', 'today.done': 'qabul qilindi',
      'tab.today': 'Bugun', 'tab.courses': 'Kurslar', 'tab.settings': 'Profil',
      'g.morning': 'Xayrli tong', 'g.day': 'Xayrli kun', 'g.evening': 'Xayrli kech',
      'today.progress': '{a} / {b} qabul', 'today.allDone': 'Bugungi barcha qabullar belgilandi', 'today.next': 'Keyingisi',
      'today.asNeeded': 'Zaruratga qarab', 'today.empty': 'Bugun qabullar yoʻq',
      'take': 'Ichdim', 'takeLate': 'Baribir ichdim', 'skip': 'Oʻtkazib yuborish', 'later': 'Keyinroq', 'undo': 'Bekor qilish',
      'laterN': '{n} daqiqadan keyin', 'cancel': 'Bekor qilish', 'close': 'Yopish',
      'skip.title': 'Nega oʻtkazib yuboryapsiz?', 'skip.note': 'Oʻz soʻzlaringiz bilan (ixtiyoriy)', 'skip.send': 'Qabulni oʻtkazib yuborish',
      'r.FORGOT': 'Unutdim', 'r.NO_MEDICATION': 'Dori yoʻq', 'r.OTHER': 'Boshqa sabab',
      'prn.take': 'Qabul qildim', 'prn.count': 'Bir sutkada: {a} / {b}', 'prn.over': 'Bu belgilangandan ortiq. Shifokorga xabar beriladi.', 'prn.undo': 'Belgini bekor qilish',
      's.SCHEDULED': 'Kutilmoqda', 's.NOTIFIED': 'Qabul vaqti', 's.SNOOZED': 'Kechiktirilgan', 's.TAKEN': 'Qabul qilingan', 's.TAKEN_LATE': 'Kechikib qabul qilingan',
      's.SKIPPED': 'Oʻtkazib yuborilgan', 's.MISSED': 'Belgilanmagan', 's.SUPERSEDED': 'Bekor qilingan', 'snoozedTo': '{t} gacha',
      'courses.current': 'Joriy', 'courses.past': 'Oʻtgan', 'course.from': '{d} dagi kurs', 'course.days': '{n} kun', 'course.day': '{a}-kun, jami {b}',
      'cs.PENDING_PATIENT': 'Boshlanishini kutmoqda', 'cs.ACTIVE': 'Davom etmoqda', 'cs.PAUSED': 'Toʻxtatilgan', 'cs.COMPLETED': 'Tugallangan', 'cs.CANCELLED': 'Bekor qilingan',
      'course.adherence': 'Oʻz vaqtida', 'course.taken': 'Qabul qilingan', 'course.late': 'Kechikib', 'course.skipped': 'Oʻtkazilgan', 'course.missed': 'Belgilanmagan',
      'course.meds': 'Dorilar', 'course.history': 'Kunlar boʻyicha tarix', 'course.start': 'Kursni boshlash', 'course.startBy': '{d} gacha boshlang',
      'course.startConfirm': 'Kursni bugun boshlaysizmi?', 'course.startDetails': '1-kun — {a}, oxirgi kun — {b}. Jami qabullar: {n}.',
      'course.started': 'Kurs boshlandi', 'course.change': 'Shifokor rejani oʻzgartirdi', 'course.changeText': 'Yangi reja siz rozi boʻlganingizdan keyin kuchga kiradi.',
      'course.changeAccept': 'Yangi rejani qabul qilish', 'course.added': 'Qoʻshildi', 'course.removed': 'Olib tashlandi', 'course.changeDone': 'Yangi reja amalda',
      'course.pause': 'Shifokordan pauza soʻrash', 'course.pauseText': 'Shifokor soʻrovingizni oladi. Shifokor javob bermaguncha qabulni oʻzingiz toʻxtatmang.',
      'course.pauseSent': 'Soʻrov shifokorga yuborildi', 'course.asNeeded': 'zaruratga qarab, sutkada {n} martagacha', 'course.instr': 'Shifokor koʻrsatmalari',
      'f.BEFORE_MEAL': 'ovqatdan oldin', 'f.WITH_MEAL': 'ovqat vaqtida', 'f.AFTER_MEAL': 'ovqatdan keyin', 'f.ANY': 'ovqatga bogʻliq emas',
      'u.MG': 'mg', 'u.G': 'g', 'u.MCG': 'mkg', 'u.ML': 'ml', 'u.TABLET': 'tabl.', 'u.CAPSULE': 'kaps.', 'u.DROP': 'tomchi', 'u.IU': 'XB', 'u.PUFF': 'nafas', 'u.SACHET': 'sashe', 'u.OTHER': 'birl.',
      'history.prn': 'zaruratga qarab',
      'set.language': 'Til', 'set.alarm': 'Budilnik', 'set.alarmOn': 'Qabul vaqtida kuy chalinsin', 'set.alarmTest': 'Ovozni tekshirish',
      'set.alarmNote': 'Ilova ochiq turganda chalinadi. Yopiq yoki qulflangan telefonda veb-versiya chala olmaydi — buning uchun Telegram eslatmalari bor.',
      'set.melody': 'Kuy', 'set.theme': 'Koʻrinish', 'set.dark': 'Tungi mavzu', 'set.theme': 'Koʻrinish', 'th.night': 'Tun', 'th.mint': 'Yalpiz', 'th.dusk': 'Shom', 'mel.soft': 'Yumshoq', 'mel.classic': 'Klassik', 'mel.bright': 'Jarangdor',
      'set.install': '«Uy» ekraniga oʻrnatish', 'set.installText': 'Safari pastidagi «Ulashish»ni, keyin «Uy ekraniga»ni bosing.',
      'set.privacy': 'Rozilik va maʼlumotlar', 'set.logout': 'Chiqish', 'set.logoutText': 'Demodan chiqib, kirishga qaytasizmi?',
      'demo.badge': 'Demo', 'demo.banner': 'Demo rejim: maʼlumotlar haqiqiy emas, hech narsa yuborilmaydi.',
      'privacy.consent': 'Rozilik berilgan: {d}', 'privacy.doctors': 'Shifokorlarim', 'privacy.withdraw': 'Rozilikni qaytarib olish', 'privacy.delete': 'Maʼlumotlarimni oʻchirish',
      'privacy.demo': 'Demoda bu amallar hech narsani oʻzgartirmaydi.',
      'alarm.title': 'Qabul vaqti', 'alarm.enable': 'Budilnikni yoqish', 'alarm.enableText': 'Ovozga ruxsat berish uchun bosing: brauzer sizning bosishingizsiz kuy chalmaydi.',
      'alarm.on': 'Budilnik yoqildi', 'alarm.off': 'Budilnik oʻchirildi',
      'err.too_early': 'Juda erta: qabuldan bir soatdan oldin belgilab boʻlmaydi.', 'err.not_correctable': 'Javobni endi oʻzgartirib boʻlmaydi: bir soat oʻtdi.',
      'err.generic': 'Nimadir notoʻgʻri ketdi. Yana urinib koʻring.',
    },
  };

  const store = {
    get: (k, d) => { try { const v = localStorage.getItem('mc.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem('mc.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  const S = {
    lang: store.get('lang', 'ru'),
    phase: 'signin',
    tab: 'today',
    stack: [],
    alarmOn: store.get('alarmOn', true),
    melody: store.get('melody', 'soft'),
    rung: new Set(store.get('rung', [])),
    today: null,
  };
  const Theme = {
    key: 'mc.theme',
    isDark() {
      const forced = document.documentElement.getAttribute('data-theme');
      return forced ? forced === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    },
    toggle() {
      const next = this.isDark() ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(this.key, next); } catch (e) { /* private mode */ }
      this.paint();
    },
    paint() {
      const meta = document.querySelector('meta[name=theme-color]');
      if (meta) meta.content = this.isDark() ? '#000000' : '#fbfbfd';
    },
    button() {
      const sun = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="3.75"/><path d="M12 3v1.5M12 19.5V21M4.22 4.22l1.06 1.06M18.72 18.72l1.06 1.06M3 12h1.5M19.5 12H21M4.22 19.78l1.06-1.06M18.72 5.28l1.06-1.06"/></svg>';
      const moon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z"/></svg>';
      return `<button class="theme-btn" data-theme-toggle aria-label="theme">${this.isDark() ? sun : moon}</button>`;
    },
    bind(root, rerender) {
      root.querySelectorAll('[data-theme-toggle]').forEach((b) => { b.onclick = () => { this.toggle(); vibrate(8); rerender(); }; });
    },
  };
  const t = (k, p) => {
    let s = (T[S.lang] && T[S.lang][k]) || T.ru[k] || k;
    if (p) for (const key in p) s = s.split('{' + key + '}').join(p[key]);
    return s;
  };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------- API (demo now; same contract as apps/api) ----------
  async function api(method, path, body) {
    await new Promise((r) => setTimeout(r, 180));
    const [status, data] = window.Demo.respond(method, '/v1' + path, body || {});
    if (status >= 200 && status < 300) return data;
    const err = new Error(data.error || 'error');
    err.code = data.error;
    throw err;
  }

  // ---------- Formatting (course zone: Asia/Tashkent) ----------
  const ZONE = 'Asia/Tashkent';
  const loc = () => (S.lang === 'uz' ? 'uz-Latn-UZ' : 'ru-RU');
  const fmt = (d, opts) => { try { return new Intl.DateTimeFormat(loc(), Object.assign({ timeZone: ZONE }, opts)).format(new Date(d)); } catch (e) { return new Date(d).toLocaleString(); } };
  const time = (d) => fmt(d, { hour: '2-digit', minute: '2-digit', hour12: false });
  const dayMonth = (d) => fmt(d, { day: 'numeric', month: 'long' });
  const localDay = (s) => fmt(s + 'T12:00:00Z', { day: 'numeric', month: 'long' });
  const weekday = (s) => { const v = fmt(s + 'T12:00:00Z', { weekday: 'long', day: 'numeric', month: 'long' }); return v.charAt(0).toUpperCase() + v.slice(1); };
  const todayLocal = () => new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
  const amount = (m) => (m.doseDisplay || (Number.isInteger(m.doseValue) ? m.doseValue : String(m.doseValue))) + ' ' + t('u.' + m.doseUnit);
  const hourNow = () => new Date(Date.now() + 5 * 3600000).getUTCHours();

  // ---------- Icons ----------
  const I = {
    sun: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4.5"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></g></svg>',
    case: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6a2 2 0 0 1 2 2v1h2.5A2.5 2.5 0 0 1 22 8.5v10a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5v-10A2.5 2.5 0 0 1 4.5 6H7V5a2 2 0 0 1 2-2zm0 3h6V5H9v1zm2 4v2.5H8.5v2H11V17h2v-2.5h2.5v-2H13V10h-2z"/></svg>',
    person: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm0 9c-2.6 0-4.8 1.2-6 3a8 8 0 0 0 12 0c-1.2-1.8-3.4-3-6-3z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    alarm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M4 4.5L6.5 2.5M20 4.5l-2.5-2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.7 3.3a1 1 0 0 0-1-.2L3 9.6a1 1 0 0 0 0 1.9l7.3 2.3 2.3 7.3a1 1 0 0 0 1.9 0l6.5-17.7a1 1 0 0 0-.3-1.1z"/></svg>',
    steth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 3v5a5 5 0 0 0 10 0V3"/><path d="M10 13v2a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="11" r="2"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="12" width="4" height="8" rx="1.5"/><rect x="10" y="7" width="4" height="13" rx="1.5"/><rect x="16" y="3" width="4" height="17" rx="1.5"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 9 15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 1.5l6 6-6 6"/></svg>',
    back: '<svg viewBox="0 0 12 20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2L2 10l8 8"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3zm-1 13.5l6-6-1.4-1.4-4.6 4.6-2.1-2.1L7.5 12l3.5 3.5z"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7.5 7.5L12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a6 6 0 0 0-6 6v3.6L4.3 15a1 1 0 0 0 .9 1.5h13.6a1 1 0 0 0 .9-1.5L18 11.6V8a6 6 0 0 0-6-6zm-2.5 16a2.5 2.5 0 0 0 5 0h-5z"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7L12 2z"/></svg>',
    tg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.4 4.3L18.3 19c-.2 1-.8 1.3-1.7.8l-4.6-3.4-2.2 2.1c-.2.2-.5.5-1 .5l.3-4.7 8.6-7.8c.4-.3-.1-.5-.6-.2L6.5 13 2 11.6c-1-.3-1-1 .2-1.5L20.1 3.2c.8-.3 1.6.2 1.3 1.1z"/></svg>',
  };
  const statusIcon = (s) => {
    const c = { TAKEN: 'var(--success)', TAKEN_LATE: 'var(--warning)', SKIPPED: 'var(--danger)', MISSED: 'var(--danger)', SNOOZED: 'var(--warning)', NOTIFIED: 'var(--accent)' }[s] || 'var(--muted)';
    const inner = { TAKEN: '<path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      TAKEN_LATE: '<path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      SKIPPED: '<path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
      MISSED: '<path d="M12 7v6" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1.4" fill="#fff"/>',
      SNOOZED: '<path d="M12 7.5V12l3 2" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round"/>',
      NOTIFIED: '<path d="M12 7v6" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1.4" fill="#fff"/>' }[s];
    return inner ? `<svg class="status-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="${c}"/>${inner}</svg>`
      : `<svg class="status-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="${c}" stroke-width="2" opacity=".5"/></svg>`;
  };
  const ring = (frac, label, done, big) => {
    const r = 28, c = 2 * Math.PI * r;
    return `<div class="ring ${done ? 'done' : ''} ${big ? 'big' : ''}"><svg viewBox="0 0 66 66"><circle class="track" cx="33" cy="33" r="${r}"/><circle class="bar" cx="33" cy="33" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.max(0.001, frac))}"/></svg><div class="label">${label}</div></div>`;
  };
  const csColor = (s) => ({ ACTIVE: 'var(--success)', PENDING_PATIENT: 'var(--accent)', PAUSED: 'var(--warning)' })[s] || 'var(--muted)';
  const pill = (text, color) => `<span class="pill" style="--c:${color}">${esc(text)}</span>`;

  // ---------- Feedback ----------
  function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); }
  function toast(text, isError) {
    const root = document.getElementById('toast-root');
    root.innerHTML = `<div class="toast">${isError ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="var(--danger)"/><path d="M12 7v6" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1.4" fill="#fff"/></svg>'
      : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="var(--success)"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>'}<span>${esc(text)}</span></div>`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { const el = root.firstChild; if (el) { el.classList.add('out'); setTimeout(() => { root.innerHTML = ''; }, 300); } }, 2600);
  }
  function confetti() {
    const box = document.createElement('div');
    box.className = 'confetti';
    const colors = ['#2E85FF', '#735CFA', '#21B373', '#F99E1A', '#ED474D'];
    for (let i = 0; i < 36; i++) {
      const p = document.createElement('i');
      p.style.left = Math.random() * 100 + '%';
      p.style.background = colors[i % colors.length];
      p.style.setProperty('--dx', (Math.random() * 120 - 60) + 'px');
      p.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg');
      p.style.animationDelay = Math.random() * 0.25 + 's';
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 1900);
  }
  function fail(e) { vibrate(80); toast(T[S.lang]['err.' + e.code] ? t('err.' + e.code) : t('err.generic'), true); }

  // ---------- Sheets (own UI: never the browser's confirm/select) ----------
  function sheet(html, onMount) {
    const root = document.getElementById('sheet-root');
    root.innerHTML = `<div class="overlay"></div><div class="sheet"><div class="grabber"></div>${html}</div>`;
    const close = () => {
      const o = root.querySelector('.overlay'), s = root.querySelector('.sheet');
      if (!s) return;
      o.classList.add('out'); s.classList.add('out');
      setTimeout(() => { root.innerHTML = ''; }, 240);
    };
    root.querySelector('.overlay').onclick = close;
    if (onMount) onMount(root.querySelector('.sheet'), close);
    return close;
  }
  function confirmSheet(title, text, label, cls, action) {
    sheet(`<h3>${esc(title)}</h3><p class="text">${esc(text)}</p><button class="btn ${cls}" data-ok>${esc(label)}</button><button class="btn ghost" data-cancel>${esc(t('cancel'))}</button>`,
      (el, close) => {
        el.querySelector('[data-cancel]').onclick = close;
        el.querySelector('[data-ok]').onclick = async () => { close(); await action(); };
      });
  }

  // ---------- Alarm ----------
  const Alarm = {
    ctx: null,
    playing: null,
    unlocked: false,
    melodies: {
      soft: { wave: 'sine', notes: [[659, 0.25], [784, 0.25], [988, 0.5], [784, 0.25], [880, 0.6]], gap: 0.9 },
      classic: { wave: 'triangle', notes: [[880, 0.12], [0, 0.06], [880, 0.12], [0, 0.06], [880, 0.12], [0, 0.06], [880, 0.12]], gap: 0.7 },
      bright: { wave: 'square', notes: [[523, 0.15], [659, 0.15], [784, 0.15], [1047, 0.35], [784, 0.15], [1047, 0.45]], gap: 0.8 },
    },
    unlock() {
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
        // A silent tick: iOS lets a page play sound only after a sound was started from a tap.
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        g.gain.value = 0.0001; o.connect(g); g.connect(this.ctx.destination); o.start(); o.stop(this.ctx.currentTime + 0.05);
        this.unlocked = true;
      } catch (e) { this.unlocked = false; }
    },
    phrase(name) {
      const m = this.melodies[name] || this.melodies.soft;
      const ctx = this.ctx;
      let at = ctx.currentTime + 0.05;
      for (const [f, d] of m.notes) {
        if (f) {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = m.wave; o.frequency.value = f;
          const peak = m.wave === 'square' ? 0.08 : 0.22;
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(peak, at + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, at + d);
          o.connect(g); g.connect(ctx.destination);
          o.start(at); o.stop(at + d + 0.02);
        }
        at += d;
      }
      return (at - ctx.currentTime + m.gap) * 1000;
    },
    start(name) {
      if (!this.ctx) return;
      this.stop();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const loop = () => {
        if (!this.playing) return;
        const ms = this.phrase(name);
        vibrate([400, 200, 400]);
        this.playing.timer = setTimeout(loop, ms);
      };
      this.playing = { timer: null };
      loop();
    },
    stop() { if (this.playing) { clearTimeout(this.playing.timer); this.playing = null; } },
    test() { this.unlock(); const ms = this.phrase(S.melody); vibrate(300); return ms; },
  };

  /** The dose that should ring now: due (or back from "later") within the last 30 minutes and still unanswered. */
  function dueDose(today) {
    if (!today) return null;
    const now = Date.now();
    return today.doses.find((d) => {
      const open = ['SCHEDULED', 'NOTIFIED', 'SNOOZED'].includes(d.status);
      if (!open) return false;
      const from = d.status === 'SNOOZED' && d.snoozedUntil ? new Date(d.snoozedUntil).getTime() : new Date(d.scheduledAt).getTime();
      const key = d.id + '@' + from;
      return now >= from && now < from + 30 * 60000 && !S.rung.has(key);
    }) || null;
  }
  function ringKey(d) {
    const from = d.status === 'SNOOZED' && d.snoozedUntil ? new Date(d.snoozedUntil).getTime() : new Date(d.scheduledAt).getTime();
    return d.id + '@' + from;
  }
  function markRung(d) { S.rung.add(ringKey(d)); store.set('rung', Array.from(S.rung).slice(-200)); }

  function showAlarm(d) {
    if (document.querySelector('.alarm-screen')) return;
    const el = document.createElement('div');
    el.className = 'alarm-screen';
    el.innerHTML = `<div class="alarm-pulse"></div><div class="alarm-pulse two"></div>
      <div class="alarm-body">
        <div class="alarm-icon">${I.bell}</div>
        <div class="alarm-time">${esc(time(d.scheduledAt))}</div>
        <div class="alarm-title">${esc(t('alarm.title'))}</div>
        <div class="alarm-med">${esc(d.medication.displayName)}</div>
        <div class="alarm-sub">${esc(amount(d.medication))} · ${esc(t('f.' + d.medication.foodRule))}</div>
      </div>
      <div class="alarm-actions">
        <button class="btn white big" data-a="take">${I.check}${esc(t('take'))}</button>
        <div class="btn-row">
          ${(d.snoozeOptions.length ? d.snoozeOptions : [10]).map((n) => `<button class="btn glass grow" data-a="snooze" data-n="${n}">${esc(t('laterN', { n }))}</button>`).join('')}
        </div>
        <button class="btn ghost light" data-a="skip">${esc(t('skip'))}</button>
      </div>`;
    document.body.appendChild(el);
    if (S.alarmOn) Alarm.start(S.melody);
    const done = () => { Alarm.stop(); markRung(d); el.classList.add('out'); setTimeout(() => el.remove(), 300); };
    el.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = async () => {
        const a = b.dataset.a;
        done();
        if (a === 'take') await answer(d, () => api('POST', `/doses/${d.id}/take`));
        else if (a === 'snooze') await answer(d, () => api('POST', `/doses/${d.id}/snooze`, { minutes: Number(b.dataset.n) }));
        else skipSheet(d);
      };
    });
  }

  async function tick() {
    if (S.phase !== 'app') return;
    try {
      const today = await api('GET', '/today');
      S.today = today;
      const d = dueDose(today);
      if (d) showAlarm(d);
    } catch (e) { /* offline: try again on the next tick */ }
  }

  // ---------- Screens ----------
  const app = () => document.getElementById('app');
  function render() {
    if (S.phase === 'signin') return renderSignIn();
    const top = S.stack[S.stack.length - 1];
    if (top) return top.render();
    if (S.tab === 'today') return renderToday();
    if (S.tab === 'courses') return renderCourses();
    return renderSettings();
  }
  function tabbar() {
    const b = (id, icon, key) => `<button data-tab="${id}" class="${S.tab === id ? 'on' : ''}">${icon}<span>${esc(t(key))}</span></button>`;
    return `<nav class="tabbar">${b('today', I.sun, 'tab.today')}${b('courses', I.case, 'tab.courses')}${b('settings', I.person, 'tab.settings')}</nav>`;
  }
  function bindTabs() {
    app().querySelectorAll('[data-tab]').forEach((el) => { el.onclick = () => { S.tab = el.dataset.tab; S.stack = []; vibrate(8); render(); window.scrollTo(0, 0); }; });
  }
  function push(screen) { S.stack.push(screen); render(); window.scrollTo(0, 0); }
  function pop() { S.stack.pop(); render(); }
  function topbar(title) { return `<div class="topbar"><button class="back" data-back>${I.back}<span>${esc(t('tab.' + S.tab))}</span></button><h1>${esc(title || '')}</h1><div class="spacer"></div></div>`; }
  function bindBack() { const b = app().querySelector('[data-back]'); if (b) b.onclick = pop; }

  function renderSignIn() {
    app().innerHTML = `<div class="signin">${Theme.button()}<div class="bubble a"></div><div class="bubble b"></div>
      <div class="logo"><img src="icon-192.png?v=6" alt=""></div>
      <h1>${esc(t('app.name'))}</h1><h2>${esc(t('signin.title'))}</h2><p>${esc(t('signin.subtitle'))}</p>
      <div class="actions">
        <button class="btn white" data-tg>${I.tg}${esc(t('signin.button'))}</button>
        <div class="segmented">${['ru', 'uz'].map((l) => `<button data-lang="${l}" class="${S.lang === l ? 'on' : ''}">${l === 'ru' ? 'Русский' : 'Oʻzbekcha'}</button>`).join('')}</div>
        <button class="btn glass tap" data-demo>${I.sparkle}${esc(t('signin.demo'))}</button>
      </div></div>`;
    const root = app();
    root.querySelector('[data-tg]').onclick = () => toast(t('signin.soon'));
    Theme.bind(root, renderSignIn);
    root.querySelectorAll('[data-lang]').forEach((b) => { b.onclick = () => { S.lang = b.dataset.lang; store.set('lang', S.lang); renderSignIn(); }; });
    root.querySelector('[data-demo]').onclick = () => {
      Alarm.unlock();
      window.Demo.reset();
      S.rung = new Set(); store.set('rung', []);
      S.phase = 'app'; S.tab = 'today'; S.stack = []; S.today = null;
      vibrate(15);
      render();
    };
  }

  async function renderToday() {
    const greet = t(hourNow() >= 4 && hourNow() < 12 ? 'g.morning' : hourNow() < 18 && hourNow() >= 12 ? 'g.day' : 'g.evening');
    const head = `<div class="head-row"><div><div class="eyebrow">${esc(weekday(todayLocal()))} ${pill(t('demo.badge'), 'var(--warning)')}</div><div class="greeting">${esc(greet)}, Farhod</div></div>${Theme.button()}</div>`;
    if (!S.today) {
      app().innerHTML = `<div class="screen">${head}<div class="stack"><div class="card skeleton"></div><div class="card skeleton"></div></div></div>${tabbar()}`;
      bindTabs();
      try { S.today = await api('GET', '/today'); } catch (e) { fail(e); return; }
      if (S.tab !== 'today' || S.stack.length) return;
    }
    const today = S.today;
    const counted = today.doses.filter((d) => d.status !== 'SUPERSEDED');
    const isOpen = (d) => ['SCHEDULED', 'NOTIFIED', 'SNOOZED'].includes(d.status);
    const answered = counted.filter((d) => !isOpen(d)).length;
    const next = counted.filter(isOpen).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0];
    const frac = counted.length ? answered / counted.length : 0;
    const allDone = counted.length > 0 && answered === counted.length;

    const alarmCard = !Alarm.unlocked && S.alarmOn
      ? `<button class="card tap row" data-unlock style="text-align:left"><div class="empty-ico">${I.alarm}</div><div class="grow"><div class="bold">${esc(t('alarm.enable'))}</div><div class="small muted">${esc(t('alarm.enableText'))}</div></div></button>` : '';

    const progress = counted.length ? `<div class="card progress-card">${ring(frac, allDone ? `<span style="color:var(--success)">${I.check.replace('<svg', '<svg width="24" height="24"')}</span>` : Math.round(frac * 100) + '%', allDone)}
      <div class="grow"><div class="bold">${esc(t('today.progress', { a: answered, b: counted.length }))}</div>
      <div class="small muted">${allDone ? esc(t('today.allDone')) : next ? esc(t('today.next') + ': ' + time(next.scheduledAt) + ' · ' + next.medication.displayName) : ''}</div></div></div>` : '';

    const cards = today.doses.map((d) => doseCard(d, next && d.id === next.id)).join('');
    const prn = today.asNeeded.length ? `<div class="section-title">${esc(t('today.asNeeded'))}</div><div class="stack">${today.asNeeded.map(prnCard).join('')}</div>` : '';

    app().innerHTML = `<div class="screen">${head}<div class="stack">${alarmCard}${progress}${cards || `<div class="card empty"><h3>${esc(t('today.empty'))}</h3></div>`}</div>${prn}</div>${tabbar()}`;
    bindTabs();
    const root = app();
    const u = root.querySelector('[data-unlock]');
    if (u) u.onclick = () => { Alarm.test(); toast(t('alarm.on')); renderToday(); };
    Theme.bind(root, renderToday);
    root.querySelectorAll('[data-dose]').forEach((el) => {
      const d = today.doses.find((x) => x.id === el.dataset.dose);
      el.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = () => {
          Alarm.unlock();
          const a = b.dataset.act;
          if (a === 'take') answer(d, () => api('POST', `/doses/${d.id}/take`));
          else if (a === 'skip') skipSheet(d);
          else if (a === 'later') laterSheet(d);
          else if (a === 'undo') answer(d, () => api('POST', `/doses/${d.id}/undo`));
        };
      });
    });
    root.querySelectorAll('[data-prn]').forEach((b) => {
      b.onclick = async () => {
        try {
          if (b.dataset.prn === 'take') { const r = await api('POST', `/prn/${b.dataset.id}/take`); vibrate(20); if (r.overLimit) toast(t('prn.over'), true); }
          else await api('POST', `/prn/events/${b.dataset.id}/undo`);
          S.today = await api('GET', '/today'); renderToday();
        } catch (e) { fail(e); }
      };
    });
  }

  function doseCard(d, isNext) {
    const open = ['SCHEDULED', 'NOTIFIED', 'SNOOZED'].includes(d.status);
    const sub = `${esc(amount(d.medication))} · ${esc(t('f.' + d.medication.foodRule))}`;
    let body;
    if (open || d.status === 'MISSED') {
      body = `<div class="dose-actions"><button class="btn ${d.status === 'MISSED' ? 'warning' : 'success'}" data-act="take">${I.check}${esc(t(d.status === 'MISSED' ? 'takeLate' : 'take'))}</button>
        ${open ? `<div class="btn-row">${d.snoozeOptions.length ? `<button class="btn soft warning" data-act="later">${I.alarm}${esc(t('later'))}</button>` : ''}<button class="btn soft danger" data-act="skip">${I.x}${esc(t('skip'))}</button></div>` : ''}
        ${d.status === 'SNOOZED' && d.snoozedUntil ? `<div class="small muted" style="margin-top:8px">${esc(t('s.SNOOZED'))} ${esc(t('snoozedTo', { t: time(d.snoozedUntil) }))}</div>` : ''}</div>`;
    } else {
      const color = { TAKEN: 'var(--success)', TAKEN_LATE: 'var(--warning)' }[d.status] || 'var(--danger)';
      const canUndo = d.correctableUntil && new Date(d.correctableUntil) > new Date();
      body = `<div class="dose-footer">${pill(t('s.' + d.status), color)}${d.skipReason ? `<span class="tiny muted">${esc(t('r.' + d.skipReason))}</span>` : ''}<span class="grow"></span>${canUndo ? `<button class="link" data-act="undo">${esc(t('undo'))}</button>` : ''}</div>`;
    }
    return `<div class="card ${isNext ? 'next' : ''}" data-dose="${esc(d.id)}"><div class="dose-head"><div class="dose-time ${isNext ? 'next' : ''}">${esc(time(d.scheduledAt))}</div>
      <div class="grow"><div class="dose-name">${esc(d.medication.displayName)}</div><div class="small muted">${sub}</div></div>${statusIcon(d.status)}</div>${body}</div>`;
  }
  function prnCard(p) {
    const undo = p.undoable && new Date(p.undoable.until) > new Date();
    return `<div class="card"><div class="row"><div class="grow"><div class="dose-name">${esc(p.displayName)}</div><div class="small muted">${esc(amount(p))}</div></div>
      <div class="tiny mono bold" style="color:${p.overLimit ? 'var(--warning)' : 'var(--muted)'}">${esc(t('prn.count', { a: p.takenInDay, b: p.maxDailyDoses }))}</div></div>
      <div class="btn-row"><button class="btn soft" data-prn="take" data-id="${esc(p.medicationId)}">${I.plus}${esc(t('prn.take'))}</button>${undo ? `<button class="btn soft grey" data-prn="undo" data-id="${esc(p.undoable.eventId)}">${I.undo}${esc(t('prn.undo'))}</button>` : ''}</div></div>`;
  }

  async function answer(d, call) {
    const card = app().querySelector(`[data-dose="${d.id}"]`);
    if (card) card.classList.add('busy');
    try {
      const r = await call();
      const fresh = r.dose;
      if (fresh && (fresh.status === 'TAKEN' || fresh.status === 'TAKEN_LATE')) vibrate([15, 40, 25]); else vibrate(12);
      S.today = await api('GET', '/today');
      const counted = S.today.doses.filter((x) => x.status !== 'SUPERSEDED');
      const allDone = counted.length && counted.every((x) => !['SCHEDULED', 'NOTIFIED', 'SNOOZED'].includes(x.status));
      if (fresh && fresh.status === 'TAKEN' && allDone) confetti();
      if (S.tab === 'today' && !S.stack.length) renderToday();
    } catch (e) {
      fail(e);
      if (card) card.classList.remove('busy');
    }
  }
  function skipSheet(d) {
    let reason = 'FORGOT';
    sheet(`<h3>${esc(t('skip.title'))}</h3><p class="text">${esc(d.medication.displayName)}</p>
      ${['FORGOT', 'NO_MEDICATION', 'OTHER'].map((r) => `<button class="choice ${r === reason ? 'on' : ''}" data-r="${r}"><span>${esc(t('r.' + r))}</span><span class="mark"></span></button>`).join('')}
      <textarea class="textarea" data-note placeholder="${esc(t('skip.note'))}" maxlength="300" style="display:none"></textarea>
      <button class="btn danger" data-send>${esc(t('skip.send'))}</button>`, (el, close) => {
      const note = el.querySelector('[data-note]');
      el.querySelectorAll('[data-r]').forEach((b) => {
        b.onclick = () => {
          reason = b.dataset.r; vibrate(8);
          el.querySelectorAll('[data-r]').forEach((x) => x.classList.toggle('on', x === b));
          note.style.display = reason === 'OTHER' ? 'block' : 'none';
        };
      });
      el.querySelector('[data-send]').onclick = () => {
        close();
        answer(d, () => api('POST', `/doses/${d.id}/skip`, { reason, note: reason === 'OTHER' ? note.value.slice(0, 300) : undefined }));
      };
    });
  }
  function laterSheet(d) {
    sheet(`<h3>${esc(t('later'))}</h3><p class="text">${esc(d.medication.displayName)}</p>
      ${d.snoozeOptions.map((n) => `<button class="choice" data-n="${n}"><span>${esc(t('laterN', { n }))}</span>${I.alarm.replace('<svg', '<svg width="20" height="20" style="color:var(--warning)"')}</button>`).join('')}
      <button class="btn ghost" data-cancel>${esc(t('cancel'))}</button>`, (el, close) => {
      el.querySelector('[data-cancel]').onclick = close;
      el.querySelectorAll('[data-n]').forEach((b) => { b.onclick = () => { close(); answer(d, () => api('POST', `/doses/${d.id}/snooze`, { minutes: Number(b.dataset.n) })); }; });
    });
  }

  async function renderCourses() {
    app().innerHTML = `<div class="screen"><div class="title-xl">${esc(t('tab.courses'))}</div><div class="stack"><div class="card skeleton"></div><div class="card skeleton"></div></div></div>${tabbar()}`;
    bindTabs();
    let list;
    try { list = (await api('GET', '/courses')).courses; } catch (e) { fail(e); return; }
    if (S.tab !== 'courses' || S.stack.length) return;
    const cur = list.filter((c) => ['PENDING_PATIENT', 'ACTIVE', 'PAUSED'].includes(c.status));
    const past = list.filter((c) => !['PENDING_PATIENT', 'ACTIVE', 'PAUSED'].includes(c.status));
    const sec = (k, arr) => (arr.length ? `<div class="section-title">${esc(t(k))}</div><div class="stack">${arr.map(courseCard).join('')}</div>` : '');
    app().innerHTML = `<div class="screen"><div class="title-xl">${esc(t('tab.courses'))}</div>${sec('courses.current', cur)}${sec('courses.past', past)}</div>${tabbar()}`;
    bindTabs();
    app().querySelectorAll('[data-course]').forEach((el) => { el.onclick = () => { vibrate(8); push({ render: () => renderCourse(el.dataset.course) }); }; });
  }
  function courseDay(first) {
    if (!first) return null;
    return Math.floor((new Date(todayLocal() + 'T00:00:00Z') - new Date(first + 'T00:00:00Z')) / 86400000) + 1;
  }
  function courseCard(c) {
    const day = c.status === 'ACTIVE' ? courseDay(c.firstDay) : null;
    const pct = c.adherence && c.adherence.percent != null ? Math.round(c.adherence.percent) : null;
    return `<button class="card tap" data-course="${esc(c.id)}" style="text-align:left;width:100%">
      <div class="row">${pill(t('cs.' + c.status), csColor(c.status))}${c.changePending ? pill(t('course.change'), 'var(--warning)') : ''}<span class="grow"></span>${I.chev}</div>
      <div class="dose-name" style="margin-top:10px">${esc(t('course.from', { d: dayMonth(c.sentAt) }))}</div>
      <div class="small muted" style="margin-top:4px">${esc(c.medications.map((m) => m.displayName).join(' · '))}</div>
      <div class="course-meta"><span>${I.steth}${esc(c.doctor.firstName + ' ' + c.doctor.lastName)}</span><span>${I.cal}${esc(t('course.days', { n: c.durationDays }))}</span>
      ${pct != null ? `<span style="color:${pct >= 80 ? 'var(--success)' : 'var(--warning)'}">${I.chart}${pct}%</span>` : ''}</div>
      ${day ? `<div class="tiny bold" style="color:var(--accent);margin-top:12px">${esc(t('course.day', { a: Math.min(day, c.durationDays), b: c.durationDays }))}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, (day / c.durationDays) * 100)}%"></div></div>` : ''}
    </button>`;
  }

  async function renderCourse(id) {
    app().innerHTML = `<div class="screen no-tabs">${topbar('')}<div class="stack"><div class="card skeleton"></div><div class="card skeleton"></div></div></div>`;
    bindBack();
    let c, change = null, preview = null;
    try {
      c = await api('GET', '/courses/' + id);
      if (c.changePending) change = (await api('GET', `/courses/${id}/change`)).change;
      if (c.status === 'PENDING_PATIENT') preview = await api('GET', `/courses/${id}/start`);
    } catch (e) { fail(e); return; }
    const a = c.adherence;
    const stat = (k, n, col) => `<div class="stat"><span class="dot" style="background:${col}"></span><span class="muted">${esc(t(k))}</span><b class="mono">${n}</b></div>`;
    app().innerHTML = `<div class="screen no-tabs">${topbar('')}<div class="stack">
      <div class="hero"><span class="pill white">${esc(t('cs.' + c.status))}</span><h2>${esc(t('course.from', { d: dayMonth(c.sentAt) }))}</h2>
        <div class="course-meta"><span>${I.steth}${esc(c.doctor.firstName + ' ' + c.doctor.lastName)}</span><span>${I.cal}${esc(t('course.days', { n: c.durationDays }))}</span></div></div>
      ${c.status === 'PENDING_PATIENT' ? `<div class="card">${c.startWindowTo ? `<div class="small muted" style="margin-bottom:12px">${esc(t('course.startBy', { d: dayMonth(c.startWindowTo) }))}</div>` : ''}<button class="btn" data-start>${I.play}${esc(t('course.start'))}</button></div>` : ''}
      ${change ? `<div class="card"><div class="bold" style="color:var(--warning)">${esc(t('course.change'))}</div><div class="small muted" style="margin:4px 0 6px">${esc(t('course.changeText'))}</div>
        ${change.added.map((m) => `<div class="change-line" style="color:var(--success)">${I.plus}${esc(t('course.added'))}: ${esc(m.displayName)}</div>`).join('')}
        ${change.removed.map((m) => `<div class="change-line" style="color:var(--danger)">${I.minus}${esc(t('course.removed'))}: ${esc(m.displayName)}</div>`).join('')}
        <button class="btn" style="margin-top:14px" data-accept>${I.check}${esc(t('course.changeAccept'))}</button></div>` : ''}
      ${a && a.occurred ? `<div class="card progress-card">${ring((a.percent || 0) / 100, Math.round(a.percent || 0) + '%', true, true)}<div class="grow"><div class="bold" style="margin-bottom:6px">${esc(t('course.adherence'))}</div>
        ${stat('course.taken', a.taken, 'var(--success)')}${stat('course.late', a.takenLate, 'var(--warning)')}${stat('course.skipped', a.skipped, 'var(--danger)')}${stat('course.missed', a.missed, 'var(--muted)')}</div></div>` : ''}
      <div class="section-title" style="margin:8px 0 0">${esc(t('course.meds'))}</div>
      ${c.medications.map((m) => `<div class="card"><div class="row"><div class="dose-name grow">${esc(m.displayName)}</div><div class="bold small" style="color:var(--accent)">${esc(amount(m))}</div></div>
        <div class="small muted" style="margin-top:4px">${esc(t('f.' + m.foodRule))}</div>
        ${m.asNeeded ? `<div class="small muted">${esc(t('course.asNeeded', { n: m.maxDailyDoses }))}</div>` : `<div class="chips">${m.times.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>`}
        ${m.instructions ? `<div class="instr">${esc(t('course.instr'))}: ${esc(m.instructions)}</div>` : ''}</div>`).join('')}
      ${c.status !== 'PENDING_PATIENT' ? `<button class="card tap row" data-history style="width:100%;text-align:left">${I.cal}<span class="grow bold">${esc(t('course.history'))}</span>${I.chev}</button>` : ''}
      ${c.status === 'ACTIVE' ? `<button class="btn soft warning" data-pause>${esc(t('course.pause'))}</button>` : ''}
    </div></div>`;
    bindBack();
    const root = app();
    const st = root.querySelector('[data-start]');
    if (st) st.onclick = () => {
      const o = preview && preview.outlook;
      confirmSheet(t('course.startConfirm'), o ? t('course.startDetails', { a: localDay(o.firstDay), b: localDay(o.lastDay), n: o.dosesTotal }) : '', t('course.start'), '', async () => {
        try { await api('POST', `/courses/${id}/start`); vibrate([15, 40, 25]); confetti(); toast(t('course.started')); renderCourse(id); } catch (e) { fail(e); }
      });
    };
    const ac = root.querySelector('[data-accept]');
    if (ac) ac.onclick = async () => { try { await api('POST', `/courses/${id}/change/accept`); vibrate(20); toast(t('course.changeDone')); renderCourse(id); } catch (e) { fail(e); } };
    const ps = root.querySelector('[data-pause]');
    if (ps) ps.onclick = () => confirmSheet(t('course.pause'), t('course.pauseText'), t('course.pause'), 'warning', async () => {
      try { await api('POST', `/courses/${id}/pause-request`); toast(t('course.pauseSent')); } catch (e) { fail(e); }
    });
    const hs = root.querySelector('[data-history]');
    if (hs) hs.onclick = () => push({ render: () => renderHistory(id) });
  }

  async function renderHistory(id) {
    let data;
    try { data = await api('GET', `/courses/${id}/days?page=1`); } catch (e) { fail(e); return; }
    app().innerHTML = `<div class="screen no-tabs">${topbar(t('course.history'))}
      ${data.days.map((day) => `<div class="list-head">${esc(weekday(day.date))}</div><div class="list">${day.entries.map((e) => `<div class="list-item">${statusIcon(e.status || 'TAKEN')}
        <div class="grow"><div class="bold">${esc(e.displayName)}</div><div class="tiny muted">${esc(e.status ? t('s.' + e.status) : t('history.prn'))}</div></div><div class="small muted mono">${esc(time(e.at))}</div></div>`).join('')}</div>`).join('')}
    </div>`;
    bindBack();
  }

  function renderSettings() {
    const mel = ['soft', 'classic', 'bright'];
    app().innerHTML = `<div class="screen"><div class="title-xl">${esc(t('tab.settings'))}</div>
      <div class="list"><div class="list-item" style="color:var(--warning)">${I.sparkle}<span class="small">${esc(t('demo.banner'))}</span></div></div>
      <div class="list" style="margin-top:14px"><div class="list-item"><div class="avatar">FD</div><div class="grow"><div class="bold">Farhod Demo</div><div class="small muted">${ZONE}</div></div></div></div>
      <div class="list-head">${esc(t('set.theme'))}</div>
      <div class="list"><button class="list-item button" data-dark>${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z"/></svg>'}<span class="grow">${esc(t('set.dark'))}</span><span class="switch ${Theme.isDark() ? 'on' : ''}"><i></i></span></button></div>
      <div class="list-head">${esc(t('set.language'))}</div>
      <div class="list"><div class="list-item"><div class="segmented light">${['ru', 'uz'].map((l) => `<button data-lang="${l}" class="${S.lang === l ? 'on' : ''}">${l === 'ru' ? 'Русский' : 'Oʻzbekcha'}</button>`).join('')}</div></div></div>
      <div class="list-head">${esc(t('set.alarm'))}</div>
      <div class="list">
        <button class="list-item button" data-alarm>${I.bell}<span class="grow">${esc(t('set.alarmOn'))}</span><span class="switch ${S.alarmOn ? 'on' : ''}"><i></i></span></button>
        <div class="list-item"><div class="segmented light">${mel.map((m) => `<button data-mel="${m}" class="${S.melody === m ? 'on' : ''}">${esc(t('mel.' + m))}</button>`).join('')}</div></div>
        <button class="list-item button accent" data-test>${I.play}<span>${esc(t('set.alarmTest'))}</span></button>
        <div class="list-item"><span class="tiny muted">${esc(t('set.alarmNote'))}</span></div>
      </div>
      <div class="list-head">${esc(t('set.install'))}</div>
      <div class="list"><div class="list-item install-tip">${I.share}<span class="small">${esc(t('set.installText'))}</span></div></div>
      <div class="list" style="margin-top:22px">
        <button class="list-item button" data-privacy>${I.lock}<span class="grow">${esc(t('set.privacy'))}</span>${I.chev}</button>
        <button class="list-item button danger" data-logout>${I.out}<span>${esc(t('set.logout'))}</span></button>
      </div></div>${tabbar()}`;
    bindTabs();
    const root = app();
    root.querySelectorAll('[data-lang]').forEach((b) => { b.onclick = () => { S.lang = b.dataset.lang; store.set('lang', S.lang); renderSettings(); }; });
    root.querySelector('[data-dark]').onclick = () => { Theme.toggle(); vibrate(8); renderSettings(); };
    root.querySelector('[data-alarm]').onclick = () => { S.alarmOn = !S.alarmOn; store.set('alarmOn', S.alarmOn); if (S.alarmOn) Alarm.unlock(); vibrate(10); toast(t(S.alarmOn ? 'alarm.on' : 'alarm.off')); renderSettings(); };
    root.querySelectorAll('[data-mel]').forEach((b) => { b.onclick = () => { S.melody = b.dataset.mel; store.set('melody', S.melody); Alarm.test(); renderSettings(); }; });
    root.querySelector('[data-test]').onclick = () => Alarm.test();
    root.querySelector('[data-privacy]').onclick = () => push({ render: renderPrivacy });
    root.querySelector('[data-logout]').onclick = () => confirmSheet(t('set.logout'), t('set.logoutText'), t('set.logout'), 'danger', async () => {
      Alarm.stop(); S.phase = 'signin'; S.today = null; S.stack = []; render();
    });
  }

  async function renderPrivacy() {
    let p;
    try { p = await api('GET', '/privacy'); } catch (e) { fail(e); return; }
    app().innerHTML = `<div class="screen no-tabs">${topbar(t('set.privacy'))}
      <div class="list"><div class="list-item" style="color:var(--success)">${I.lock}<span>${esc(t('privacy.consent', { d: dayMonth(p.consent.at) }))}</span></div></div>
      <div class="list-head">${esc(t('privacy.doctors'))}</div>
      <div class="list">${p.doctors.map((d) => `<div class="list-item">${I.steth}<span>${esc(d.firstName + ' ' + d.lastName)}</span></div>`).join('')}</div>
      <div class="list" style="margin-top:22px"><button class="list-item button danger" data-w>${esc(t('privacy.withdraw'))}</button><button class="list-item button danger" data-d>${esc(t('privacy.delete'))}</button></div>
    </div>`;
    bindBack();
    app().querySelector('[data-w]').onclick = () => toast(t('privacy.demo'));
    app().querySelector('[data-d]').onclick = () => toast(t('privacy.demo'));
  }

  // ---------- Boot ----------
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); if (S.phase === 'app' && S.tab === 'today' && !S.stack.length && S.today) renderToday(); } });
  setInterval(tick, 15000);
  setInterval(() => { if (S.phase === 'app' && S.tab === 'today' && !S.stack.length && !document.querySelector('.sheet') && !document.querySelector('.alarm-screen')) renderToday(); }, 60000);
  Theme.paint();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { Theme.paint(); render(); });
  render();
  window.__mc = { S, Alarm, tick, dueDose };
})();
