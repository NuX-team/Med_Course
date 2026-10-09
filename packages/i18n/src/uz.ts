import type { MessageKey } from './ru';

/**
 * Uzbek, Latin script (D-15). Typed against the Russian keys. A native speaker must review it
 * before any real patient sees it (TZ §13); the consent text also needs legal approval.
 */
export const uz: Record<MessageKey, string> = {
  'welcome.text':
    "Assalomu alaykum! Men dorilarni unutmasligingizga yordam beraman: shifokoringiz tuzgan reja bo'yicha eslatib turaman va javoblaringizni qayd etaman.",

  'consent.title': "📄 Ma'lumotlarni qayta ishlashga rozilik",
  'consent.text': [
    "Boshlashdan oldin shaxsiy ma'lumotlaringizni qayta ishlashga roziligingiz kerak.",
    "Nimalarni yigʻamiz: ism va familiya, vaqt mintaqasi, Telegram identifikatori, keyinroq esa shifokoringiz tayinlagan dorilar haqidagi ma'lumotlar va eslatmalarga javoblaringiz (ichdim, keyinroq, oʻtkazib yubordim).",
    "Nima uchun: shifokoringiz rejasi bo'yicha dori ichishni eslatish va bu reja qanday bajarilayotganini unga koʻrsatish uchun.",
    'Kim koʻradi: siz va botda bogʻlanadigan davolovchi shifokoringiz. Boshqa odamlar ruxsat olmaydi.',
    'Rozilikni bekor qilish uchun klinikangizga murojaat qilishingiz mumkin.',
    'Bot shifokorni almashtirmaydi va shoshilinch yordam xizmati emas.',
  ].join('\n\n'),
  'consent.accept': '✅ Roziman',
  'consent.decline': '✖️ Rad etish',
  'consent.declined':
    'Roziliksiz davom eta olmayman. Fikringiz oʻzgarsa, quyidagi tugmani bosing yoki /start yuboring.',
  'consent.reconsider': '↩️ Rozilikka qaytish',

  'onboarding.askFirstName': 'Ismingiz nima? Ismingizni yozing.',
  'onboarding.askLastName': 'Rahmat, {name}. Endi familiyangizni yozing.',
  'onboarding.invalidName': 'Oʻqib boʻlmadi. Iltimos, oddiy matn bilan, 100 belgidan oshmasin.',
  'onboarding.askTimezone':
    'Vaqt mintaqangiz — {zone}mi? Eslatmalarni shu vaqt boʻyicha yuboraman.',
  'onboarding.done':
    '✅ Tayyor, {name}! Shifokor sizga kurs tayinlaganda, u shu yerda paydo boʻladi.',

  'timezone.confirm': '✅ Ha, toʻgʻri',
  'timezone.other': '🌍 Boshqa',
  'timezone.pick': 'Shaharingizni tanlang:',
  'timezone.city.tashkent': 'Toshkent (UTC+5)',
  'timezone.city.almaty': 'Almati (UTC+5)',
  'timezone.city.moscow': 'Moskva (UTC+3)',
  'timezone.city.istanbul': 'Istanbul (UTC+3)',
  'timezone.city.dubai': 'Dubay (UTC+4)',
  'timezone.city.seoul': 'Seul (UTC+9)',

  'menu.hello': 'Assalomu alaykum, {name}!',
  'menu.title': 'Asosiy menyu',
  'menu.course': '📋 Mening kursim',
  'menu.today': '📅 Bugun',
  'menu.history': '🕘 Tarix',
  'menu.settings': '⚙️ Sozlamalar',

  'course.none':
    'Tayinlangan kurslar hozircha yoʻq. Shifokor kurs yaratib, taklif yuborganda, uni shu yerda koʻrasiz.',
  'today.none': 'Bugun uchun dori ichish yoʻq: faol kurs hozircha yoʻq.',
  'history.none': 'Tarix boʻsh: hozircha kurslar boʻlmagan.',

  'settings.title': 'Sozlamalar',
  'settings.language': '🌐 Til',
  'settings.languagePick': 'Tilni tanlang:',
  'settings.languageChanged': 'Til oʻzgartirildi: oʻzbekcha.',
  'settings.timezone': '🕓 Vaqt mintaqasi',
  'settings.timezoneCurrent': 'Hozir: {zone}. Yangisini tanlang:',
  'settings.timezoneChanged': 'Vaqt mintaqasi oʻzgartirildi: {zone}.',

  'menu.doctor': '🩺 Shifokorlar uchun',

  'course.doctorsTitle': 'Shifokorlaringiz:',
  'course.doctorActive': '{name} — ulangan',
  'course.doctorPending': '{name} — shifokor tasdiqlashini kutmoqda',

  'invite.offer':
    'Shifokor {doctor} sizni ulanishga taklif qilmoqda. Shifokor ismingizni koʻradi, siz uchun dori ichish kurslarini yarata oladi va ularning bajarilishini koʻra oladi. Ulanasizmi?',
  'invite.accept': '✅ Ulanish',
  'invite.decline': '✖️ Hozir emas',
  'invite.accepted':
    '✅ Tayyor. Shifokor javobingizni oldi. U sizning ekanligingizni tasdiqlashi bilan sizga kurs tayinlay oladi. Sizga yozaman.',
  'invite.declined':
    'Mayli, ulanish bekor qilindi. Havola muddati tugamaguncha amal qiladi: unga qaytish mumkin.',
  'invite.invalid':
    'Bu havola yaroqsiz yoki muddati oʻtgan. Shifokordan yangisini yuborishini soʻrang.',
  'invite.throttled': 'Juda koʻp notoʻgʻri urinish. Keyinroq urinib koʻring.',
  'invite.self': 'Bu sizning oʻzingizning taklif havolangiz. Uni bemorga yuboring.',
  'invite.alreadyConnected': 'Siz bu shifokorga allaqachon ulangansiz.',
  'invite.alreadyPending':
    'Siz bu taklifni allaqachon qabul qilgansiz. Shifokor tasdiqlashini kutamiz, sizga yozaman.',
  'invite.connected':
    '✅ Shifokor {doctor} ulanishni tasdiqladi. U sizga kurs tayinlaganda, uni shu yerga yuboraman.',
  'invite.rejected':
    'Shifokor ulanishni tasdiqlamadi. Agar bu xato boʻlsa, shifokordan yangi havola yuborishini soʻrang.',

  'doctor.intro':
    'Bu boʻlim shifokorlar uchun: bu yerda bemorlarni taklif qilasiz va ular ulangach, ular uchun dori ichish kurslarini yaratasiz. Avval arizangizni xizmat administratori tekshiradi: tekshiruvdan oldin bemorlarni ulab boʻlmaydi.',
  'doctor.register': '📝 Ariza topshirish',
  'doctor.askNote':
    'Bitta xabarda yozing: qayerda ishlaysiz, mutaxassisligingiz va litsenziya raqami (bor boʻlsa). Buni faqat tekshiruvchi koʻradi. 500 belgidan oshmasin.',
  'doctor.invalidNote': 'Oʻqib boʻlmadi. Iltimos, oddiy matn bilan, 500 belgidan oshmasin.',
  'doctor.applied':
    '✅ Ariza qabul qilindi. Uni administrator tekshiradi, men sizga shu yerda yozaman. Tekshiruvdan oldin bemorlarni ulab boʻlmaydi.',
  'doctor.pending': 'Arizangiz tekshiruvda. Koʻrib chiqilgach, sizga shu yerda yozaman.',
  'doctor.revoked':
    'Shifokor huquqi yopilgan. Agar bu xato boʻlsa, xizmat administratoriga murojaat qiling.',
  'doctor.suspended':
    'Amaliyotingiz faoliyati toʻxtatilgan. Xizmat administratoriga murojaat qiling.',
  'doctor.verified':
    '✅ Arizangiz tasdiqlandi. Bemorni taklif qilish uchun menyu → «Shifokorlar uchun» ni oching.',
  'doctor.menuTitle': 'Shifokor kabineti',
  'doctor.invite': '➕ Bemorni taklif qilish',
  'doctor.patients': '👥 Mening bemorlarim',
  'doctor.invitations': '✉️ Takliflar',
  'doctor.askLabel':
    'Bemorning ismi nima? Bu faqat siz uchun belgi: bemor uni koʻrmaydi, siz esa taklifni shu belgi bilan taniysiz. Oʻtkazib yuborish mumkin.',
  'doctor.skip': '⏭ Oʻtkazib yuborish',
  'doctor.invalidLabel':
    'Oʻqib boʻlmadi. Ismni oddiy matn bilan, 100 belgidan oshmasin yozing yoki «Oʻtkazib yuborish» ni bosing.',
  'doctor.inviteReady':
    '✉️ Taklif tayyor. Bu havolani bemorga istalgan qulay usulda yuboring:\n\n{link}\n\nHavola bir martalik va {hours} soat amal qiladi. Bemor rozi boʻlgach, uning aynan oʻsha odam ekanini tasdiqlashingizni soʻrayman.',
  'doctor.inviteLimit':
    'Ishlatilmagan takliflar juda koʻp. Keraksizlarini «Takliflar» boʻlimida bekor qiling.',
  'doctor.notAllowed': 'Hozir bu mavjud emas: ariza tasdiqlanmagan yoki huquq yopilgan.',
  'doctor.patientsTitle': 'Sizning bemorlaringiz:',
  'doctor.patientsNone': 'Hozircha ulangan bemor yoʻq. Birinchisini taklif qiling.',
  'doctor.patientActive': '{name} — ulangan',
  'doctor.patientPending': '{name} — sizning tasdiqlashingizni kutmoqda',
  'doctor.invitationsTitle': 'Hali qabul qilinmagan takliflar:',
  'doctor.invitationsNone': 'Qabul qilinmagan takliflar yoʻq.',
  'doctor.invitationLine': '{label} — yana {hours} soat',
  'doctor.noLabel': 'belgisiz',
  'doctor.more': '…yana {count} ta',
  'doctor.invitationGone':
    'Bu taklif allaqachon qabul qilingan, bekor qilingan yoki muddati tugagan.',
  'doctor.revokeButton': '🗑 Bekor qilish: {label}',
  'doctor.invitationRevoked': 'Taklif bekor qilindi. Havola endi ishlamaydi.',
  'doctor.patientAccepted': '🔔 Bemor {name} taklifni qabul qildi.',
  'doctor.yourNote': 'Sizning belgingiz: {label}.',
  'doctor.confirmQuestion':
    'Bu siz taklif qilgan odammi? Agar shunday boʻlsa, unga kurs tayinlay olasiz.',
  'doctor.confirm': '✅ Ha, oʻsha odam',
  'doctor.reject': '✖️ Yoʻq, boshqa odam',
  'doctor.confirmed': '✅ Bemor {name} ulandi.',
  'doctor.rejected': 'Bemor {name} ulanishi rad etildi.',
  'doctor.decisionStale': 'Bu ulanish allaqachon koʻrib chiqilgan yoki mavjud emas.',

  'doctor.newCourse': '💊 Yangi kurs',
  'doctor.courses': '📋 Kurslar',

  'unit.MG': 'mg',
  'unit.G': 'g',
  'unit.MCG': 'mkg',
  'unit.ML': 'ml',
  'unit.TABLET': 'tabl.',
  'unit.CAPSULE': 'kaps.',
  'unit.DROP': 'tomchi',
  'unit.IU': 'XB',
  'unit.PUFF': 'nafas',
  'unit.SACHET': 'sashe',
  'unit.OTHER': 'birl.',

  'food.BEFORE_MEAL': 'ovqatdan oldin',
  'food.WITH_MEAL': 'ovqat vaqtida',
  'food.AFTER_MEAL': 'ovqatdan keyin',
  'food.ANY': 'ovqatga bogʻliq emas',

  'status.DRAFT': 'qoralama',
  'status.PENDING_PATIENT': 'boshlanishini kutmoqda',
  'status.ACTIVE': 'davom etmoqda',
  'status.PAUSED': 'toʻxtatib turilgan',
  'status.CANCELLATION_REVIEW': 'bekor qilish koʻrib chiqilmoqda',
  'status.CANCELLED': 'bekor qilingan',
  'status.EXPIRED_NOT_STARTED': 'muddatida boshlanmagan',
  'status.COMPLETED': 'tugallangan',
  'status.ARCHIVED': 'arxivda',

  'cw.pickPatient': 'Kurs kim uchun? Bemorni tanlang.',
  'cw.noPatients':
    'Kursni faqat ulangan bemor uchun yaratish mumkin. Avval bemorni taklif qiling va ulanishni tasdiqlang.',
  'cw.copyOffer':
    'Bemor: {patient}.\n\nUnda {date} sanasidagi kurs boʻlgan. Noldan boshlaysizmi yoki oldingi kursni asos qilib olasizmi?',
  'cw.fromScratch': '✏️ Noldan',
  'cw.copyLast': '📄 Oldingi kurs kabi',
  'cw.askDuration':
    'Bemor: {patient}.\n\nKurs necha kunga tayinlanadi? Tanlang yoki 1 dan 365 gacha son yozing.',
  'cw.invalidDuration': '1 dan 365 gacha butun kun soni kerak.',
  'cw.daysButton': '{days} kun',
  'cw.askNewDuration':
    'Hozir kurs {days} kun davom etadi. Yangi davomiylikni yozing: 1 dan 365 gacha son.',
  'cw.durationConflict':
    'Boʻlmaydi: «{name}» dorisi bunday kursda boʻlmaydigan kunlarga tayinlangan. Avval uni olib tashlang yoki uzunroq davomiylikni tanlang.',
  'cw.askName': 'Dori nomi? Bemor eslatmada qanday koʻrsa, shunday yozing.',
  'cw.invalidMedName': 'Oʻqib boʻlmadi. Nomni oddiy matn bilan, 120 belgidan oshmasin yozing.',
  'cw.askDose':
    '{name}: bir martalik doza qancha? Faqat son yozing, masalan 500, 0,5 yoki 1/2. Birlikni keyingi qadamda tanlaysiz.',
  'cw.invalidDose': 'Noldan katta son kerak, masalan 500, 0,5 yoki 1/2.',
  'cw.askUnit': '{name}: {dose} dozasi nimada oʻlchanadi?',
  'cw.askFood': '{name}, {dose}: ovqatga nisbatan qanday qabul qilinadi?',
  'cw.askFrequency': '{name}: kuniga necha marta qabul qilinadi?',
  'cw.freq1': 'Kuniga 1 marta',
  'cw.freq2': 'Kuniga 2 marta',
  'cw.freq3': 'Kuniga 3 marta',
  'cw.freq4': 'Kuniga 4 marta',
  'cw.ownTimes': '🕓 Oʻz vaqtim',
  'cw.prn': 'Zaruratga qarab',
  'cw.proposeTimes':
    '{name}: qabul vaqti {times} (bemor soati boʻyicha).\n\nAgar vaqtni tizim taklif qilgan boʻlsa, bu tibbiy tavsiya emas: uni tekshirib tasdiqlang yoki oʻzingiznikini kiriting.',
  'cw.confirmTimes': '✅ Tasdiqlash',
  'cw.changeTimes': '✏️ Vaqtni oʻzgartirish',
  'cw.askTimes':
    'Qabul vaqtini boʻsh joy yoki vergul bilan yozing, masalan: 08:00 14:30 22:00. Vaqt bemor soati boʻyicha koʻrsatiladi.',
  'cw.invalidTimes':
    'Vaqtni oʻqib boʻlmadi. Misol: 08:00 14:30 22:00. Kuniga 12 martadan koʻp emas, takrorlarsiz.',
  'cw.askPrnMax':
    '{name} zaruratga qarab: sutkada koʻpi bilan necha marta qabul qilish mumkin? 1 dan 24 gacha son yozing.',
  'cw.invalidPrnMax': '1 dan 24 gacha butun son kerak.',
  'cw.askPrnInterval': 'Qabullar orasidagi eng kam tanaffus qancha?',
  'cw.minutes': '{n} daq',
  'cw.hours': '{n} soat',
  'cw.askDays': '{name}: kursning qaysi kunlarida qabul qilinadi? Kurs {days} kun davom etadi.',
  'cw.wholeCourse': 'Butun kurs',
  'cw.someDays': 'Kunlarni koʻrsatish',
  'cw.askDayRange': 'Kurs kunlarini yozing, masalan 1-5. Kurs {days} kun davom etadi.',
  'cw.invalidDayRange': 'Kurs doirasidagi kunlar kerak, masalan 1-5. Kurs {days} kun davom etadi.',
  'cw.askInstructions':
    'Bu dori boʻyicha bemorga alohida koʻrsatma bormi? Bitta xabarda yozing (300 belgigacha) yoki oʻtkazib yuboring.',
  'cw.invalidInstructions':
    'Oʻqib boʻlmadi. Oddiy matn bilan, 300 belgidan oshmasin yozing yoki oʻtkazib yuboring.',
  'cw.skip': '⏭ Koʻrsatmasiz',
  'cw.limitMeds': 'Bitta kursda {max} tadan koʻp dori boʻlishi mumkin emas.',
  'cw.notAvailable': 'Bu kurs mavjud emas yoki uni endi oʻzgartirib boʻlmaydi.',
  'cw.draftTitle': '📝 Kurs qoralamasi',
  'cw.addMed': '➕ Dori qoʻshish',
  'cw.removeMed': '🗑 Dorini olib tashlash',
  'cw.changeDuration': '📅 Davomiylikni oʻzgartirish',
  'cw.send': '📨 Bemorga yuborish',
  'cw.discard': '❌ Qoralamani oʻchirish',
  'cw.pickRemove': 'Qaysi dorini olib tashlaysiz?',
  'cw.discardConfirm': '{patient} uchun kurs qoralamasi oʻchirilsinmi? Uni qaytarib boʻlmaydi.',
  'cw.discardYes': 'Ha, oʻchirish',
  'cw.discarded': 'Qoralama oʻchirildi.',
  'cw.sendConfirm':
    'Yuqoridagi tayinlovni yana bir bor tekshiring. Yuborilgach, bemor kursni koʻradi. U boshlamaguncha kursni qaytarib olish mumkin; boshlangach reja faqat bemor roziligi bilan oʻzgaradi.\n\nBemorda kursni boshlash uchun necha kun bor? Tugmani bosish kursni yuboradi.',
  'cw.cannotSend': 'Kursni hozircha yuborib boʻlmaydi:',
  'cw.problem.NO_MEDICATIONS': 'kursda birorta ham dori yoʻq',
  'cw.problem.DUPLICATE_SLOT': '«{name}» dorisida bir vaqtning oʻzida ikkita qabul bor',
  'cw.problem.MEDICATION_OUTSIDE_COURSE': '«{name}» dorisi kurs davomiyligidan chiqib ketadi',
  'cw.problem.TOO_MANY_SLOTS': 'kursda qabullar juda koʻp',
  'cw.problem.OTHER': 'tayinlov toʻliq toʻldirilmagan ({code})',
  'cw.sent':
    '✅ Kurs {patient} bemoriga yuborildi. Hozircha eslatmalar yoʻq: ular bemor kursni boshlaganda boshlanadi. {until} gacha boshlash mumkin (bemor soati boʻyicha).',
  'cw.listTitle': 'Sizning kurslaringiz:',
  'cw.listNone': 'Hozircha kurslar yoʻq.',
  'cw.listLine': '{patient} — {status}, {days} kun',

  'card.patient': 'Bemor: {name}',
  'card.doctor': 'Shifokor: {name}',
  'card.status': 'Holati: {status}',
  'card.duration': 'Davomiyligi: {days} kun',
  'card.window': '{until} gacha boshlash mumkin',
  'card.noMeds': 'Hozircha dorilar yoʻq.',
  'card.everyDay': 'har kuni soat {times} da',
  'card.prn':
    'zaruratga qarab: sutkada koʻpi bilan {max} marta, oradagi tanaffus kamida {interval}',
  'card.days': 'kurs kunlari: {from}–{to}',
  'card.note': 'koʻrsatma: {text}',
  'card.timezone': 'Vaqt bemor soati boʻyicha koʻrsatilgan ({zone}).',

  'course.title': '📋 Sizning kursingiz',
  'course.assigned': '💊 Shifokor {doctor} sizga davolash kursini tayinladi.',
  'course.pendingNote':
    'Kurs hali boshlanmagan, hozircha eslatmalar yoʻq. Uni {until} gacha boshlash kerak.',
  'course.followDoctor':
    'Dorilarni shifokor tayinlaganidek qabul qiling. Biror narsa tushunarsiz boʻlsa, shifokoringiz bilan bogʻlaning. Bot shifokorni almashtirmaydi va shoshilinch yordam xizmati emas.',

  'course.start': '▶️ Kursni boshlash',
  'course.startN': '▶️ {n}-kursni boshlash',
  'course.titleN': '📋 {n}-kurs',
  'card.started': '{date} da boshlangan, oxirgi kun — {last}',
  'card.day': 'Bugun {days} kunning {day}-kuni',

  'start.question': 'Kursni hozir boshlaysizmi?',
  'start.dayOne': 'Bugun, {date}, {days} kunning 1-kuni boʻladi. Kursning oxirgi kuni — {last}.',
  'start.todayFull': 'Bugungi qabullar: {count}. Birinchi eslatma soat {time} da keladi.',
  'start.todayPartial':
    'Bugungi qabullarning bir qismi oʻtib ketgan: {planned} tadan {left} tasi qoldi. Oʻtib ketgan qabullar koʻchirilmaydi va oʻtkazib yuborilgan deb hisoblanmaydi. Birinchi eslatma soat {time} da keladi.',
  'start.todayNone': 'Bugun boshqa qabul boʻlmaydi. Birinchi eslatma {first} da keladi.',
  'start.prnOnly':
    'Bu kursda faqat «zaruratga qarab» qabul qilinadigan dorilar bor: jadval boʻyicha eslatmalar boʻlmaydi.',
  'start.irreversible': 'Boshlangandan keyin boshlanish sanasini oʻzgartirib boʻlmaydi.',
  'start.confirm': '✅ Ha, boshlash',
  'start.later': 'Hozir emas',
  'start.done':
    '✅ Kurs boshlandi. 1-kun — bugun, {date}; oxirgi kun — {last}. Jadval boʻyicha eslatmalar yuborib turaman.',
  'start.already': 'Bu kurs allaqachon boshlangan.',
  'start.tooLate':
    'Bu kursni boshlash mumkin boʻlgan muddat {until} da tugagan. Kursni qaytadan tayinlashi uchun shifokor ({doctor}) bilan bogʻlaning.',
  'start.tooEarly': 'Bu kursni hozircha boshlab boʻlmaydi.',
  'start.doctorUnavailable':
    'Bu kursni hozir boshlab boʻlmaydi. Shifokoringiz yoki klinikangiz bilan bogʻlaning.',
  'start.nothingLeft':
    'Bugun bu kursning barcha qabullari oʻtib ketgan: hozir boshlansa, unda birorta ham qabul qolmaydi. Boshqa kuni boshlang, lekin {until} dan kechikmang.',
  'start.notAvailable': 'Bu kurs mavjud emas.',
  'doctor.courseStarted':
    '🔔 Bemor {patient} kursni boshladi. 1-kun — {date}, oxirgi kun — {last}.',

  'today.title': '📅 Bugun, {date}',
  'today.nothing': 'Bugun uchun qabullar yoʻq.',
  'dose.SCHEDULED': 'kutilmoqda',
  'dose.NOTIFIED': 'eslatma yuborildi',
  'dose.SNOOZED': 'keyinga qoldirilgan',
  'dose.TAKEN': 'qabul qilindi',
  'dose.SKIPPED': 'siz oʻtkazib yubordingiz',
  'dose.MISSED': 'oʻtkazib yuborilgan',
  'dose.TAKEN_LATE': 'kechikib qabul qilindi',
  'dose.SUPERSEDED': 'jadvaldan olib tashlangan',

  'reminder.title': '💊 Dori ichish vaqti keldi',
  'reminder.again': '🔔 Yana eslataman: dori ichish vaqti keldi',
  'reminder.lead': '⏳ Tez orada dori ichish vaqti',
  'reminder.time': 'Qabul vaqti: {time}',
  'reminder.until': 'Qabulni oʻz vaqtida soat {time} gacha belgilash mumkin.',

  'dose.take': '✅ Ichdim',
  'dose.takeLate': '✅ Baribir ichdim',
  'dose.later': '⏰ {n} daqiqadan keyin',
  'dose.skip': '❌ Oʻtkazib yuborish',
  'dose.undo': '↩️ Javobni tuzatish',
  'dose.skipAsk': 'Bu qabulni nega oʻtkazib yuboryapsiz?',
  'dose.reason.FORGOT': 'Unutdim',
  'dose.reason.NO_MEDICATION': 'Dori yoʻq',
  'dose.reason.OTHER': 'Boshqa sabab',
  'dose.reasonAsk':
    'Sababni bitta xabarda yozing (300 belgigacha) yoki «Izohsiz» ni bosing.\n\nBu yerga shoshilinch tibbiy maʼlumot yozmang: bot shoshilinch yordam xizmati emas. Agar yomon boʻlsangiz, tez yordam chaqiring yoki shifokorga murojaat qiling.',
  'dose.reasonSilent': 'Izohsiz',
  'dose.reasonInvalid':
    'Oʻqib boʻlmadi. Oddiy matn bilan, 300 belgidan oshmasin yozing yoki «Izohsiz» ni bosing.',
  'dose.state.waiting': 'Javobingiz kutilmoqda. Oʻz vaqtida soat {time} gacha belgilash mumkin.',
  'dose.state.snoozed': '⏰ Soat {time} da eslataman.',
  'dose.state.taken': '✅ Soat {time} da qabul qilindi.',
  'dose.state.takenLate':
    '✅ Kechikib, soat {time} da qabul qilindi. Qabul oʻz vaqtida belgilanmagan deb yozilgan holda qoladi.',
  'dose.state.skipped': '❌ Oʻtkazib yuborildi. Sababi: {reason}.',
  'dose.state.missed':
    'Bu qabul oʻz vaqtida belgilanmadi va oʻtkazib yuborilgan deb yozildi. Agar dorini baribir ichgan boʻlsangiz, buni belgilang.',
  'dose.tooEarly':
    'Bu qabulni belgilashga hali erta: buni qabuldan koʻpi bilan bir soat oldin qilish mumkin.',
  'dose.tooLate': 'Bu qabulning vaqti oʻtib ketdi.',
  'dose.snoozeNotAllowed':
    'Endi buncha vaqtga kechiktirib boʻlmaydi: eslatma juda kech kelgan boʻlardi.',
  'dose.notCorrectable': 'Bu javobni endi oʻzgartirib boʻlmaydi: tuzatish vaqti tugagan.',
  'dose.undone': 'Oldingi javob bekor qilindi.',
  'dose.notAvailable': 'Bu qabul mavjud emas: kurs hozir davom etmayapti yoki jadval oʻzgargan.',

  'cw.pause': '⏸ Kursni toʻxtatib turish',
  'cw.pauseConfirm':
    '{patient} bemorining kursi toʻxtatib turilsinmi?\n\nEslatmalar darhol toʻxtaydi. Hali javob berilmagan qabullar jadvaldan olinadi va oʻtkazib yuborilgan deb hisoblanmaydi. Kurs toʻliq pauzada turgan kunlar uning davomiyligiga kirmaydi. Bemorga xabar yuboriladi.',
  'cw.pauseYes': 'Ha, toʻxtatib turish',
  'cw.paused':
    '⏸ {patient} bemorining kursi toʻxtatib turildi. Eslatmalar toʻxtatildi, bemorga xabar yuborildi.',
  'cw.resume': '▶️ Kursni davom ettirish',
  'cw.resumeConfirm':
    '{patient} bemorining kursi davom ettirilsinmi?\n\nEslatmalar amaldagi reja boʻyicha yana kela boshlaydi. Pauzaga toʻgʻri kelgan qabullar qoplanmaydi. Bemorga xabar yuboriladi.',
  'cw.resumeYes': 'Ha, davom ettirish',
  'cw.resumed':
    '▶️ {patient} bemorining kursi davom ettirildi. Kursning oxirgi kuni — {last}. Bemorga xabar yuborildi.',
  'cw.cancel': '⛔ Kursni bekor qilish',
  'cw.cancelConfirm':
    '{patient} bemorining kursi butunlay bekor qilinsinmi?\n\nEslatmalar darhol toʻxtaydi, kursni qayta davom ettirib boʻlmaydi. Yozib olingan javoblar va oʻtkazib yuborishlar saqlanadi. Bemorga xabar yuboriladi.',
  'cw.cancelYes': 'Ha, kursni bekor qilish',
  'cw.cancelled':
    '⛔ {patient} bemorining kursi bekor qilindi. Endi eslatmalar boʻlmaydi, bemorga xabar yuborildi.',
  'cw.withdraw': '↩️ Kursni qaytarib olish',
  'cw.withdrawConfirm':
    '{patient} bemoriga yuborilgan kurs qaytarib olinsinmi?\n\nBemor uni hali boshlamagan va qaytarib olingach boshlay olmaydi. Tayinlovni tuzatish uchun shundan soʻng yangi kurs yarating: buni asos qilib olish mumkin.',
  'cw.withdrawYes': 'Ha, qaytarib olish',
  'cw.withdrawn':
    '↩️ {patient} bemori uchun kurs qaytarib olindi, bemorga xabar yuborildi. Tuzatilgan kursni tayinlash uchun quyidagi tugmani bosing.',
  'cw.newForPatient': '📝 Shu bemorga yangi kurs',
  'cw.wrongState': 'Bu amal hozir mavjud emas. Kurs holati: {status}.',
  'cw.change': '✏️ Rejani oʻzgartirish',
  'cw.changeContinue': '✏️ Oʻzgartirishni davom ettirish',
  'cw.changeTitle': '✏️ Reja oʻzgarishi (hali yuborilmagan)',
  'cw.changeHint':
    'Dorilarni qoʻshing yoki olib tashlang. Doza yoki qabul vaqtini oʻzgartirish uchun dorini olib tashlab, qaytadan qoʻshing. Kurs davomiyligi oʻzgarmaydi. Bemor oʻzgarishni qabul qilmaguncha avvalgi reja amal qiladi.',
  'cw.changeNone': 'Hozircha hech narsa oʻzgartirilmagan.',
  'cw.changeAdded': 'Qoʻshildi: {names}',
  'cw.changeRemoved': 'Olib tashlandi: {names}',
  'cw.changeSend': '📨 Oʻzgarishni bemorga yuborish',
  'cw.changeSendConfirm':
    'Bu oʻzgarish {patient} bemoriga yuborilsinmi? Yangi reja bemor uni qabul qilganda kuchga kiradi; ungacha avvalgisi amal qiladi.',
  'cw.changeSendYes': 'Ha, yuborish',
  'cw.changeSent':
    '✅ Oʻzgarish {patient} bemoriga yuborildi. U qabul qilmaguncha avvalgi reja amal qiladi. Qabul qilganda sizga xabar keladi.',
  'cw.changeUnchanged': 'Yangi reja amaldagidan farq qilmaydi: yuboradigan narsa yoʻq.',
  'cw.changeDrop': '❌ Oʻzgarishni bekor qilish',
  'cw.changeDropped': 'Reja oʻzgarishi bekor qilindi. Avvalgi reja amal qiladi.',
  'cw.changeDraftNote': '✏️ Yuborilmagan reja oʻzgarishi bor.',
  'cw.changeWaiting': '⏳ Reja oʻzgarishi bemorga yuborilgan va uning tasdigʻini kutmoqda.',
  'cw.changeWithdraw': '↩️ Oʻzgarishni qaytarib olish',
  'doctor.changeAccepted':
    '🔔 Bemor {patient} reja oʻzgarishini qabul qildi. Yangi reja amal qilmoqda.',

  'card.startedOpen': '{date} da boshlangan',
  'card.pausedSince':
    '{since} dan beri pauzada. Oxirgi kun shifokor kursni davom ettirganda maʼlum boʻladi.',
  'course.paused':
    '⏸ Shifokor {doctor} kursingizni toʻxtatib turdi. Shifokor uni davom ettirmaguncha eslatmalar boʻlmaydi. Pauza vaqtida dorilar bilan qanday yoʻl tutishni shifokordan soʻrang.',
  'course.resumed':
    '▶️ Shifokor {doctor} kursingizni davom ettirdi. Eslatmalar yana jadval boʻyicha kela boshlaydi. Kursning oxirgi kuni — {last}.',
  'course.cancelled':
    '⛔ Shifokor {doctor} kursingizni bekor qildi. U boʻyicha endi eslatmalar boʻlmaydi. Savollaringiz boʻlsa, shifokorga murojaat qiling.',
  'course.withdrawn':
    '↩️ Shifokor {doctor} sizga avval yuborgan kursni qaytarib oldi. Uni boshlash kerak emas. Shifokor yangi kurs tayinlasa, u alohida xabar bilan keladi.',
  'course.changeProposed': '✏️ Shifokor {doctor} kursingiz rejasini oʻzgartirdi.',
  'course.changeNewPlan': 'Yangi reja:',
  'course.changeAsk':
    'Oʻzgarishni qabul qilmaguningizcha avvalgi reja amal qiladi. Biror narsa tushunarsiz boʻlsa, shifokordan soʻrang.',
  'course.changeAccept': '✅ Yangi rejani qabul qilish',
  'course.changeView': '✏️ Reja oʻzgarishini koʻrish',
  'course.changeViewN': '✏️ {n}-kurs rejasidagi oʻzgarish',
  'course.changePending':
    '✏️ Shifokor rejani oʻzgartirishni taklif qildi. Yangi reja siz uni qabul qilganingizda kuchga kiradi.',
  'course.changeApplied': '✅ Yangi reja qabul qilindi va shu paytdan boshlab amal qiladi.',
  'course.changeNextDose': 'Keyingi eslatma {time} da keladi.',
  'course.changeAppliedPaused':
    '✅ Yangi reja qabul qilindi. Kurs hozir pauzada: eslatmalar shifokor uni davom ettirganda boshlanadi.',
  'course.changeNothing': 'Tasdigʻingizni kutayotgan oʻzgarish yoʻq. Joriy reja amal qiladi.',
  'course.changeDropped':
    'Shifokor {doctor} reja oʻzgarishini qaytarib oldi. Avvalgi reja amal qiladi.',
  'course.changeDoctorUnavailable':
    'Bu oʻzgarishni hozir qabul qilib boʻlmaydi. Shifokoringiz yoki klinikangiz bilan bogʻlaning.',
  'course.completed':
    '🏁 Kurs yakunlandi: oxirgi kuni {last} edi. U boʻyicha endi eslatmalar boʻlmaydi. Keyingi davolanishni shifokor bilan muhokama qiling.',
  'start.withdrawn': 'Shifokor bu kursni qaytarib olgan. Uni boshlab boʻlmaydi.',

  'history.title': '🕘 Kurslar tarixi',
  'history.course': '{n}-kurs: {status}, {date} da boshlangan',
  'history.courseNotStarted': '{n}-kurs: {status}',
  'history.figure': 'Vaqtida qabul qilingan: {occurred} tadan {taken} tasi ({percent}%)',
  'history.noFigure': 'Vaqti kelgan qabullar hali yoʻq',
  'history.open': '📋 {n}-kurs',
  'history.empty': 'Bu kursda hali qabullar boʻlmagan.',
  'history.page': '{pages} sahifadan {page}-sahifa (avval oxirgi kunlar)',
  'history.prnEntry': 'zaruratga qarab',
  'history.skippedByPatient': 'bemor oʻtkazib yuborgan',
  'history.notAvailable': 'Bu kurs mavjud emas.',
  'report.title': '📊 Jadvalga rioya qilish',
  'report.due': 'Vaqti kelgan qabullar: {occurred}',
  'report.taken': 'Vaqtida qabul qilingan: {count}',
  'report.takenLate': 'Kechikib qabul qilingan: {count}',
  'report.skipped': 'Sababi koʻrsatib oʻtkazib yuborilgan: {count}',
  'report.missed': 'Muddat oxirigacha javobsiz qolgan: {count}',
  'report.percent': 'Jadvalga rioya qilish: {percent}%',
  'report.noPercent': 'Jadvalga rioya qilish: hali qabullar boʻlmagan, hisoblashga asos yoʻq',
  'report.formula':
    'Qanday hisoblanadi: vaqtida qabul qilinganlar ÷ vaqti kelgan barcha qabullar × 100. Kechikib qabul qilinganlar alohida koʻrsatiladi va foizga kirmaydi; «zaruratga qarab» qabullar va jadvaldan olinganlar hisobga olinmaydi. Bu jadvalga rioya qilish koʻrsatkichi, davolash natijasining bahosi emas.',
  'report.byMedication': 'Dorilar boʻyicha:',
  'report.medLine': '{name}: vaqtida {occurred} tadan {taken} tasi ({percent}%)',
  'report.medLineEmpty': '{name}: hali qabullar boʻlmagan',
  'report.reasons':
    'Oʻtkazib yuborish sabablari: unutgan — {forgot}, dori yoʻq — {none}, boshqa — {other}',
  'report.otherReasons': 'Oʻtkazib yuborishlarga izohlar:',
  'report.prn': 'Zaruratga qarab: {name} — belgilangan soni: {count}',
  'report.days': '📅 Kunlar boʻyicha',
  'report.older': '← Oldingilari',
  'report.newer': 'Keyingilari →',
  'report.back': '← Xulosaga',
  'cw.report': '📊 Rioya qilish',

  'prn.title': 'Zaruratga qarab:',
  'prn.line': '{name}, {dose} — bir sutkada {max} tadan {count} tasi belgilangan',
  'prn.button': '💊 Qabul qildim: {name}',
  'prn.ask':
    '«Zaruratga qarab» qabul belgilansinmi?\n\n{name}, {dose}\nShifokor tayinlovi: sutkada koʻpi bilan {max} marta, oradagi tanaffus kamida {interval}.\nOxirgi sutkada belgilangan: {count}.',
  'prn.lastAt': 'Oxirgi belgi: {time}.',
  'prn.warnInterval':
    '⚠️ Oxirgi belgidan beri shifokor tayinlagan tanaffusdan kam vaqt oʻtdi. Tayinlov boʻyicha — {time} dan oldin emas.',
  'prn.warnLimit':
    '⚠️ Bir sutkada shifokor tayinlagancha belgilab boʻlingan. Tayinlov boʻyicha — {time} dan oldin emas.',
  'prn.warnTail':
    'Agar dorini baribir qabul qilgan boʻlsangiz, buni belgilang: yozuv saqlanadi, shifokorga esa xabar boradi. Oʻzingizni yomon his qilsangiz, shifokorga murojaat qiling yoki shoshilinch yordam chaqiring.',
  'prn.confirm': '✅ Ha, qabul qildim',
  'prn.done': '✅ Belgilandi: {name}, {time}.',
  'prn.doneOver':
    '✅ Belgilandi: {name}, {time}. Bu shifokor tayinlaganidan koʻp: shifokorga xabar boradi. Oʻzingizni yomon his qilsangiz, shifokorga murojaat qiling yoki shoshilinch yordam chaqiring.',
  'prn.already': 'Bu belgi allaqachon yozilgan: {name}, {time}.',
  'prn.undo': '↩️ Belgini bekor qilish',
  'prn.undone': 'Belgi bekor qilindi: {name}.',
  'prn.undoneAlready': 'Bu belgi allaqachon bekor qilingan.',
  'prn.notCorrectable': 'Bu belgini endi bekor qilib boʻlmaydi: bir soatdan koʻp vaqt oʻtdi.',
  'prn.notAvailable':
    'Bu dorini hozir belgilab boʻlmaydi: kurs davom etmayapti yoki tayinlov oʻzgargan.',

  'course.pauseAsk': '⏸ Shifokordan pauza soʻrash',
  'course.pauseAskN': '⏸ {n}-kurs uchun pauza',
  'course.pauseQuestion':
    'Shifokor {doctor}ga kursni toʻxtatib turish haqida iltimos yuborilsinmi?\n\nKurs oʻzi toʻxtamaydi: qarorni shifokor qabul qiladi. U pauza qoʻymaguncha eslatmalar kelishda davom etadi va dorilarni tayinlanganidek qabul qilish kerak. Davolanishni oʻzboshimchalik bilan toʻxtatmang. Men shoshilinch yordam xizmati emasman: oʻzingizni yomon his qilsangiz, tez yordam chaqiring.',
  'course.pauseSend': 'Ha, iltimosni yuborish',
  'course.pauseRequested':
    'Iltimos shifokorga yuborildi. Shifokor toʻxtatib turmaguncha kurs davom etadi: dorilarni tayinlanganidek qabul qiling.',
  'course.pauseAlready':
    'Bugun bunday iltimosni allaqachon yuborgansiz. Masala shoshilinch boʻlsa, shifokor bilan bevosita bogʻlaning.',

  'alert.missed': '⚠️ Bemor {patient}: {time} dagi qabul muddat oxirigacha belgilanmadi.',
  'alert.skipped': '⚠️ Bemor {patient}: {time} dagi qabul oʻtkazib yuborildi. Sababi: {reason}.',
  'alert.series':
    '🚨 Bemor {patient}: ketma-ket qabul qilinmagan qabullar — {run} ({since} dan boshlab). Bemor bilan bogʻlaning. Keyingi oʻtkazib yuborishlar haqida faqat xulosa keladi, 6 soatda koʻpi bilan bir marta.',
  'alert.digest':
    '⚠️ Bemor {patient} hamon dorilarni qabul qilmayapti: ketma-ket qabul qilinmagan qabullar — {run} ({since} dan boshlab).',
  'alert.undelivered':
    '📵 Bemor {patient}: eslatma yetkazilmadi, Telegram xabarni rad etdi (ehtimol, bemor botni toʻxtatgan). Hozir eslatmalar unga yetib bormayapti: bemor bilan boshqa yoʻl bilan bogʻlaning.',
  'alert.pauseRequest':
    '⏸ Bemor {patient} kursni toʻxtatib turishni soʻramoqda. Siz pauza qoʻymaguningizcha kurs davom etadi.',
  'alert.prnOver':
    '⚠️ Bemor {patient} «zaruratga qarab» qabulni tayinlangandan ortiq belgiladi: {name}. Tayinlangan: sutkada koʻpi bilan {max} marta, oradagi tanaffus kamida {interval}. Shu belgi bilan birga oxirgi sutkada belgilangan: {count}.',
  'alert.openCourse': '📋 Kursni ochish',

  'menu.wards': '👁 Qaramogʻimdagilar',
  'settings.caregivers': '👁 Kursimni kim koʻradi',
  'cg.inviteButton': '👁 Vasiy: {name}',
  'cg.linkCreated':
    '{patient} bemorining vasiysi uchun havola:\n\n{link}\n\nUni dori qabul qilinishini kuzatadigan kishiga yuboring. U avval botda roʻyxatdan oʻtishi (/start), soʻng havolani ochishi kerak. Vasiy jadval va belgilarni faqat bemorning oʻzi ruxsat berganidan keyin koʻradi. Havola {until} gacha amal qiladi va bir marta ishlaydi.',
  'cg.linkLimit':
    'Bu bemor uchun vasiyga moʻljallangan bir nechta foydalanilmagan havola bor. Ular ishlatilishini yoki muddati tugashini kuting.',
  'cg.registerFirst':
    'Bu vasiy uchun havola. Avval botda roʻyxatdan oʻting, soʻng havolani yana bir bor oching.',
  'cg.linkInvalid':
    'Vasiy uchun bu havola yaroqsiz yoki eskirgan. Shifokordan yangisini yuborishni soʻrang.',
  'cg.own':
    'Bu havola sizning oʻz kursingizni kuzatish uchun yaratilgan. Uni sizga yordam beradigan kishiga yuboring.',
  'cg.already':
    'Siz {patient} bemorining kursini allaqachon kuzatyapsiz yoki uning ruxsatini kutyapsiz.',
  'cg.offer':
    'Shifokor {doctor} sizga {patient} bemorining dori qabul qilishini kuzatishni taklif qilmoqda.\n\nSiz jadval va qabul belgilarini koʻrasiz. Qabulni belgilay olmaysiz, kursni oʻzgartira olmaysiz va oʻtkazib yuborish sabablarini koʻrmaysiz. Ruxsat bemorning oʻzi bergach ochiladi; bemor uni istalgan payt yopishi mumkin.',
  'cg.accept': '✅ Rozi boʻlish',
  'cg.decline': '✖️ Rad etish',
  'cg.declined': 'Yaxshi, hech narsa oʻzgarmadi.',
  'cg.requested':
    'Soʻrov {patient} bemoriga yuborildi. U ruxsat bergach, menyuda «Qaramogʻimdagilar» boʻlimi paydo boʻladi.',
  'cg.askPatient':
    'Shifokor {doctor} vasiy qoʻshishni taklif qilmoqda: {caregiver}.\n\nVasiy sizning jadvalingiz va dori qabul qilish belgilaringizni koʻradi. Siz uchun qabulni belgilay olmaydi va kursni oʻzgartira olmaydi. Ruxsatni istalgan payt yopish mumkin: «Sozlamalar» → «Kursimni kim koʻradi».',
  'cg.allow': '✅ Ruxsat berish',
  'cg.refuse': '✖️ Ruxsat bermaslik',
  'cg.allowed': 'Ruxsat berdingiz: {caregiver} endi jadvalingiz va belgilaringizni koʻradi.',
  'cg.refused': 'Ruxsat bermadingiz: {caregiver} hech narsani koʻrmaydi.',
  'cg.youAllowed': 'Bemor {patient} sizga jadval va qabul belgilarini koʻrishga ruxsat berdi.',
  'cg.youRefused': 'Bemor {patient} oʻz jadvalini koʻrishga ruxsat bermadi.',
  'cg.notAvailable': 'Bu soʻrov endi dolzarb emas.',
  'cg.listTitle': 'Jadvalingiz va belgilaringizni kim koʻradi:',
  'cg.listActive': '{name} — koʻradi',
  'cg.listPending': '{name} — ruxsatingizni kutmoqda',
  'cg.listNone': 'Kursingizni faqat siz va shifokoringiz koʻradi.',
  'cg.revokeButton': '✖️ Ruxsatni yopish: {name}',
  'cg.revoked': 'Ruxsat yopildi: {caregiver} endi jadvalingizni koʻrmaydi.',
  'cg.youRevoked': 'Bemor {patient} oʻz jadvalini koʻrish ruxsatini yopdi.',
  'cg.wardsTitle': 'Qaramogʻingizdagilar:',
  'cg.wardsNone': 'Qaramogʻingizda hech kim yoʻq.',
  'cg.wardTitle': '👁 {patient}. Bugun, {date}',
  'cg.wardNoCourse': 'Hozir bemorda davom etayotgan kurs yoʻq.',
  'cg.wardCourse': 'Kurs: {status}',
  'cg.readOnly': 'Siz jadval va belgilarni koʻrasiz. Qabulni faqat bemorning oʻzi belgilay oladi.',
  'cg.refresh': '🔄 Yangilash',
  'cg.wardGone': 'Bu bemorning jadvalini koʻrish ruxsati yopilgan.',

  'panel.link':
    'Xodimlar paneliga kirish. Havola 5 daqiqa amal qiladi va bir marta ishlaydi:\n\n{link}\n\nUni hech kimga yubormang.',
  'app.registerFirst':
    'MedCourse ilovasiga kirish uchun avval shu yerda, botda roʻyxatdan oʻting. Keyin ilovada yana «Kirish»ni bosing.',
  'app.linkInvalid': 'Ilovaga kirish havolasi endi amal qilmaydi. Ilovada yana «Kirish»ni bosing.',
  'app.confirmAsk':
    'Telefondagi MedCourse ilovasiga kirasizmi? Faqat kirishni oʻzingiz boshlagan boʻlsangiz tasdiqlang.',
  'app.confirm': '✅ Kirishni tasdiqlash',
  'app.confirmed':
    'Tayyor: ilovaga qayting, kirish oʻzi bajariladi. Eslatmalar avvalgidek shu yerga, botga keladi.',
  'panel.tooMany': 'Havola juda koʻp soʻraldi. Chorak soatdan keyin urinib koʻring.',
  'panel.notConfigured': 'Bu serverda xodimlar paneli sozlanmagan.',

  'pn.title': 'MedCourse — xodimlar paneli',
  'pn.loginTitle': 'Panelga kirish',
  'pn.loginText': 'Kirish uchun tugmani bosing. Havola bir martalik.',
  'pn.loginButton': 'Kirish',
  'pn.loginHow': 'Kirish uchun botga /panel buyrugʻini yuboring va javobdagi havolani oching.',
  'pn.loginFailed': 'Havola yaroqsiz yoki eskirgan. Botga yana /panel yuboring.',
  'pn.signedInAs': 'Siz {name} sifatida kirdingiz',
  'pn.signOut': 'Chiqish',
  'pn.forbidden': 'Bu boʻlim sizga ochiq emas.',
  'pn.tooManyRequests': 'Juda koʻp soʻrov. Biroz kutib, qayta urinib koʻring.',
  'pn.notFound': 'Sahifa topilmadi.',
  'pn.badRequest': 'Soʻrov qabul qilinmadi. Sahifani yangilab, qaytadan urinib koʻring.',
  'pn.home.intro': 'Rolingizga ochiq boʻlimlar:',
  'pn.nav.home': 'Bosh sahifa',
  'pn.nav.doctors': 'Shifokorlar',
  'pn.nav.clinics': 'Klinikalar va xodimlar',
  'pn.nav.tech': 'Xizmat holati',
  'pn.nav.techIncidents': 'Texnik hodisalar',
  'pn.nav.audit': 'Audit jurnali',
  'pn.nav.clinic': 'Klinika',
  'pn.nav.courses': 'Kurslar',
  'pn.nav.incidents': 'Hodisalar',
  'pn.role.TECH_ADMIN': 'Texnik administrator',
  'pn.role.CLINIC_ADMIN': 'Klinika administratori: {clinic}',
  'pn.role.RECEPTION': 'Qabulxona: {clinic}',
  'pn.col.name': 'Ism',
  'pn.col.telegram': 'Telegram identifikatori',
  'pn.col.note': 'Oʻzi haqida',
  'pn.col.applied': 'Ariza berilgan',
  'pn.col.reference': 'Nima tekshirilgan',
  'pn.col.patient': 'Bemor',
  'pn.col.doctor': 'Shifokor',
  'pn.col.status': 'Holati',
  'pn.col.days': 'Kun',
  'pn.col.started': 'Boshlangan',
  'pn.col.ended': 'Tugagan',
  'pn.col.when': 'Qachon',
  'pn.col.actor': 'Kim',
  'pn.col.entity': 'Yozuv',
  'pn.col.action': 'Amal',
  'pn.col.fields': 'Oʻzgargan maydonlar',
  'pn.col.role': 'Rol',
  'pn.verification.PENDING': 'tekshiruvni kutmoqda',
  'pn.verification.VERIFIED': 'tasdiqlangan',
  'pn.verification.REVOKED': 'bekor qilingan',
  'pn.state.ACTIVE': 'amalda',
  'pn.state.SUSPENDED': 'toʻxtatilgan',
  'pn.state.REVOKED': 'ruxsat bekor qilingan',
  'pn.doctors.pending': 'Tekshiruvni kutayotganlar',
  'pn.doctors.verified': 'Tasdiqlanganlar',
  'pn.doctors.revoked': 'Bekor qilinganlar',
  'pn.doctors.none': 'Bu roʻyxatda hech kim yoʻq.',
  'pn.doctors.referenceLabel': 'Nima tekshirilgan (litsenziya, hujjat)',
  'pn.doctors.verify': 'Tasdiqlash',
  'pn.doctors.revoke': 'Ruxsatni bekor qilish',
  'pn.doctors.verifiedDone': 'Shifokor tasdiqlandi.',
  'pn.doctors.revokedDone': 'Shifokor ruxsati bekor qilindi.',
  'pn.doctors.referenceRequired': 'Aynan nima tekshirilganini koʻrsating.',
  'pn.clinics.noStaff': 'Xodimlar yoʻq.',
  'pn.clinics.add': 'Xodim qoʻshish',
  'pn.clinics.telegramLabel':
    'Xodimning Telegram identifikatori (u botda roʻyxatdan oʻtgan boʻlishi kerak)',
  'pn.clinics.roleReception': 'Qabulxona',
  'pn.clinics.roleAdmin': 'Klinika administratori',
  'pn.clinics.added': 'Xodim qoʻshildi.',
  'pn.clinics.notFound':
    'Topilmadi: bunday Telegram identifikatorli kishi avval botda roʻyxatdan oʻtishi kerak.',
  'pn.clinics.revoke': 'Bekor qilish',
  'pn.clinics.revoked': 'Xodim ruxsati bekor qilindi.',
  'pn.tech.note':
    'Bu yerda faqat sonlar va kodlar. Texnik panelda bemor ismlari va tayinlovlar yoʻq.',
  'pn.tech.reminders': 'Bemorlarga eslatmalar',
  'pn.tech.alerts': 'Shifokorlarga xabarlar',
  'pn.tech.byStatus': 'Holatlar boʻyicha',
  'pn.tech.overdue': 'Yuborish vaqti kelgan, lekin hali navbatda',
  'pn.tech.oldest': 'Eng eskisi kutmoqda, soniya',
  'pn.tech.stuck': 'Worker olgan va tugatmagan',
  'pn.tech.failures': 'Bir sutkadagi nosozliklar (kod: soni)',
  'pn.tech.sent': 'Bir sutkada yuborilgan',
  'pn.tech.delay': 'Bir sutkadagi yuborish kechikishi, soniya (mediana / 95%)',
  'pn.tech.unswept': 'Muddati oʻtgan, lekin oʻtkazib yuborish yozilmagan qabullar',
  'pn.tech.courses': 'Kurslar holatlar boʻyicha',
  'pn.tech.doctors': 'Shifokorlar holatlar boʻyicha',
  'pn.tech.users': 'Jami akkauntlar',
  'pn.inc.open': 'Ochiq',
  'pn.inc.resolved': 'Yopilgan',
  'pn.inc.none': 'Hodisalar yoʻq.',
  'pn.inc.type.UNDELIVERED': 'Eslatma yetkazilmadi',
  'pn.inc.type.MISS_SERIES': 'Ketma-ket uchta qabul qilinmadi',
  'pn.inc.type.QUEUE_STUCK': 'Yuborish toʻxtab qoldi',
  'pn.inc.type.QUEUE_LATE': 'Navbat orqada qolmoqda',
  'pn.inc.type.SWEEP_LATE': 'Oʻtkazib yuborishlar kechikib yozilmoqda',
  'pn.inc.opened': 'Ochilgan',
  'pn.inc.what': 'Nima boʻldi',
  'pn.inc.details': 'Tafsilotlar',
  'pn.inc.noteLabel': 'Nima qilindi (masalan, qoʻngʻiroq natijasi)',
  'pn.inc.resolve': 'Hodisani yopish',
  'pn.inc.resolvedDone': 'Hodisa yopildi.',
  'pn.inc.note': 'Belgi',
  'pn.inc.nameHidden': 'ism yashirilgan: klinika bu bemorni endi olib bormaydi',
  'pn.inc.callHint':
    'Bot bemorga oʻzi qoʻngʻiroq qilmaydi. Klinika bemor bilan bogʻlangan boʻlsa, yopishda natijani yozing.',
  'pn.inc.noteTooLong': 'Belgi juda uzun.',
  'pn.courses.title': 'Klinika kurslari',
  'pn.courses.none': 'Kurslar yoʻq.',
  'pn.courses.note': 'Tayinlovlar bu yerda koʻrsatilmaydi: ularni faqat shifokor va bemor koʻradi.',
  'pn.clinic.doctors': 'Klinika shifokorlari',
  'pn.audit.filter': 'Yozuv turi',
  'pn.audit.apply': 'Koʻrsatish',
  'pn.audit.older': 'Oldingilarini koʻrsatish',
  'pn.audit.note': 'Jurnalda oʻzgargan maydonlar nomlari saqlanadi, qiymatlari emas.',

  'admin.menu': '⚙️ Admin paneli',
  'admin.title': 'Admin paneli. Nimani ochamiz?',
  'admin.applicationsButton': '📋 Shifokorlar arizalari ({n})',
  'admin.doctorsButton': '👨‍⚕️ Shifokorlar',
  'admin.statsButton': '📊 Xizmat holati',
  'admin.incidentsButton': '🚨 Hodisalar',
  'admin.adminsButton': '🔑 Administratorlar',
  'admin.verifyButton': '✅ Tasdiqlash',
  'admin.revokeButton': '⛔ Huquqni bekor qilish',
  'admin.revokeYesButton': '⛔ Ha, bekor qilish',
  'admin.reinstateButton': '♻️ Huquqni tiklash',
  'admin.addAdminButton': '➕ Administrator qoʻshish',
  'admin.removeAdminButton': '⛔ Huquqni olish',
  'admin.removeAdminYesButton': '⛔ Ha, huquqni olish',
  'admin.cancelButton': 'Bekor qilish',
  'admin.applicationsTitle': 'Tekshiruvni kutayotgan shifokor arizalari: {n}. Arizani tanlang:',
  'admin.noApplications': 'Yangi ariza yoʻq.',
  'admin.doctorsTitle': 'Tasdiqlangan shifokorlar: {n}. Shifokorni tanlang:',
  'admin.noDoctors': 'Hozircha tasdiqlangan shifokor yoʻq.',
  'admin.listMore': 'Birinchi {n} tasi koʻrsatildi; qolganlari panel yoki buyruq qatori orqali.',
  'admin.status.PENDING': 'tekshiruvni kutmoqda',
  'admin.status.VERIFIED': 'tasdiqlangan',
  'admin.status.REVOKED': 'huquqi bekor qilingan',
  'admin.card': '{name}\nHolati: {status}\nTelegram id: {telegramId}\nAriza sanasi: {date}',
  'admin.cardNote': 'Yozgani: {note}',
  'admin.cardChecked': 'Tekshirilgani: {reference}',
  'admin.askReference':
    '{name} shifokorni tasdiqlaymizmi? U bemorlar bilan ishlash huquqini oladi.\n\nBitta xabarda nimani tekshirganingizni yozing (masalan: «litsenziya № … reestr boʻyicha tekshirildi»). Bu yozuv jurnalda saqlanadi.',
  'admin.referenceShort': 'Kamida bir necha soʻz yozing: aynan nimani tekshirdingiz.',
  'admin.verified': '{name} shifokor tasdiqlandi. Unga xabar yuborildi.',
  'admin.alreadyVerified': '{name} shifokor allaqachon tasdiqlangan: hech narsa oʻzgarmadi.',
  'admin.revokeAsk':
    '{name} shifokorning huquqini bekor qilamizmi? Uning bemorlarga kirishi darhol yopiladi.',
  'admin.revoked': '{name} shifokorning huquqi bekor qilindi. Kirish yopildi.',
  'admin.alreadyRevoked':
    '{name} shifokorning huquqi allaqachon bekor qilingan: hech narsa oʻzgarmadi.',
  'admin.noDoctor': 'Bunday shifokor yoʻq.',
  'admin.statsTitle': 'Xizmat holati',
  'admin.statsQueue':
    '{title}: yuborish vaqti boʻlgan, lekin navbatda — {overdue}; ishchi olgan, tugatilmagan — {stuck}',
  'admin.statsSent': 'Sutka ichida yuborilgan eslatmalar: {sent}',
  'admin.statsUnswept': 'Muddatdan keyin oʻtkazib yuborilgani yozilmagan qabullar: {n}',
  'admin.statsPeople':
    'Akkauntlar: {users}. Shifokorlar: tasdiqlangan {verified}, tekshiruvni kutayotgan {pending}.',
  'admin.statsOpenIncidents': 'Ochiq hodisalar: {n}',
  'admin.incidentsTitle': 'Ochiq hodisalar: {n}',
  'admin.noIncidents': 'Ochiq hodisalar yoʻq.',
  'admin.incidentLine': '• {type} — {date} dan beri',
  'admin.adminsTitle': 'Administratorlar: {n}',
  'admin.adminLine': '{name} · Telegram id: {telegramId}',
  'admin.noName': 'ismsiz',
  'admin.askAdminId':
    'Administrator qilinadigan odamning Telegram id raqamini yozing (faqat raqamlar). U avval botga /start yozishi kerak. Oʻz id raqamini, masalan, @userinfobot botidan bilib oladi.\n\nAdministrator shifokorlarni tasdiqlaydi, xizmat holatini koʻradi va boshqa administratorlarni tayinlay oladi.',
  'admin.badId':
    'Bu Telegram id ga oʻxshamaydi: faqat raqamlar kerak, boʻsh joysiz. Yana urinib koʻring yoki «Bekor qilish» ni bosing.',
  'admin.noAccount':
    'Bunday Telegram id li akkaunt yoʻq: odam avval botga /start yozishi kerak. Yana urinib koʻring yoki «Bekor qilish» ni bosing.',
  'admin.adminAdded': '{name} endi administrator. Unga xabar yuborildi.',
  'admin.adminAlready': '{name} allaqachon administrator.',
  'admin.youAreAdmin':
    'Sizga administrator huquqi berildi. Menyuda «Admin paneli» boʻlimi paydo boʻldi.',
  'admin.removeAdminAsk':
    '{name} dan administrator huquqini olamizmi? Kirish darhol yopiladi, veb-panelda ham.',
  'admin.adminRemoved': '{name} endi administrator emas.',
  'admin.youRemoved': 'Administrator huquqingiz olib tashlandi.',
  'admin.removeSelf':
    'Oʻz huquqingizni olib tashlab boʻlmaydi: boshqa administratordan iltimos qiling.',
  'admin.removeLast': 'Bu oxirgi administrator. Avval boshqasini tayinlang.',
  'admin.notAdmin': 'Bu odam endi administrator emas.',
  'admin.cancelled': 'Bekor qilindi.',
  'admin.noMore': 'Bu yozuv endi mavjud emas.',
  'common.back': '← Orqaga',
  'help.text': [
    'Men shifokoringiz tayinlagan dori ichish rejasiga rioya qilishga yordam beraman. Tashxis qoʻymayman va davolashni oʻzgartirmayman.',
    'Buyruqlar: /menu — asosiy menyu, /help — shu yordam.',
    'Men shoshilinch yordam xizmati emasman. Agar yomon boʻlsangiz yoki vaziyat shoshilinch boʻlsa, tez yordam chaqiring yoki shifokorga murojaat qiling.',
  ].join('\n\n'),

  'export.pdf': '📄 PDF hisobot',
  'export.csv': '📊 Excel uchun jadval (CSV)',
  'export.caption':
    'Jadvalga rioya qilish hisoboti: {name}. Tuzilgan vaqti: {at}.\n\nFaylda shaxsiy va tibbiy maʼlumotlar bor: uni faqat ishongan kishilaringizga yuboring.',
  'export.tooMany': 'Bir soatda juda koʻp fayl soʻraldi. Keyinroq urinib koʻring.',
  'rp.title': 'Dori qabul qilish jadvaliga rioya qilish hisoboti',
  'rp.fact.patient': 'Bemor',
  'rp.fact.doctor': 'Shifokor',
  'rp.fact.status': 'Kurs holati',
  'rp.fact.duration': 'Davomiyligi, kun',
  'rp.fact.started': 'Boshlangan',
  'rp.fact.lastDay': 'Oxirgi kun',
  'rp.fact.lastDayOpen': 'kurs davom ettirilganda maʼlum boʻladi',
  'rp.fact.notStarted': 'boshlanmagan',
  'rp.fact.timezone': 'Kursning vaqt mintaqasi',
  'rp.fact.generated': 'Hisobot tuzilgan vaqt',
  'rp.fact.by': 'Kim soʻragan',
  'rp.by.patient': 'bemor',
  'rp.by.doctor': 'shifokor',
  'rp.section.figures': 'Yakun',
  'rp.section.medications': 'Dorilar boʻyicha',
  'rp.section.asNeeded': '«Zaruratga qarab» qabullar',
  'rp.section.reasons': 'Oʻtkazib yuborish sabablari',
  'rp.section.pauses': 'Tanaffuslar',
  'rp.section.log': 'Barcha qabullar',
  'rp.fig.occurred': 'Vaqti kelgan qabullar',
  'rp.fig.taken': 'Vaqtida qabul qilingan',
  'rp.fig.takenLate': 'Kechikib qabul qilingan',
  'rp.fig.skipped': 'Sababi koʻrsatib oʻtkazib yuborilgan',
  'rp.fig.missed': 'Muddat oxirigacha javobsiz qolgan',
  'rp.fig.percent': 'Jadvalga rioya qilish, %',
  'rp.fig.noPercent': 'hali qabullar boʻlmagan',
  'rp.col.medication': 'Dori',
  'rp.col.dose': 'Miqdori',
  'rp.col.occurred': 'Vaqti kelgan',
  'rp.col.taken': 'Vaqtida',
  'rp.col.takenLate': 'Kechikib',
  'rp.col.skipped': 'Oʻtkazib yuborilgan',
  'rp.col.missed': 'Javobsiz',
  'rp.col.percent': 'Foiz',
  'rp.col.count': 'Necha marta belgilangan',
  'rp.col.reason': 'Sabab',
  'rp.col.times': 'Necha marta',
  'rp.col.from': 'Boshlanishi',
  'rp.col.to': 'Tugashi',
  'rp.col.date': 'Sana',
  'rp.col.time': 'Vaqt',
  'rp.col.outcome': 'Natija',
  'rp.col.answered': 'Qachon belgilangan',
  'rp.col.comment': 'Bemorning izohi',
  'rp.outcome.TAKEN': 'vaqtida qabul qilingan',
  'rp.outcome.TAKEN_LATE': 'kechikib qabul qilingan',
  'rp.outcome.SKIPPED': 'bemor oʻtkazib yuborgan',
  'rp.outcome.MISSED': 'javobsiz',
  'rp.outcome.OPEN': 'javob kutilmoqda',
  'rp.outcome.PRN': 'zaruratga qarab',
  'rp.pauseOpen': 'davom etmoqda',
  'rp.logEmpty': 'Hali qabullar boʻlmagan.',
  'rp.note.times': 'Vaqt kursning vaqt mintaqasi boʻyicha koʻrsatilgan: {zone}.',
  'rp.note.source':
    'Hisobot bemorning Telegram-botdagi belgilari asosida tuzilgan. «Qabul qilindi» belgisi — bemorning xabari, tasdiqlangan qabul fakti emas.',
  'rp.page': '{pages} sahifadan {page}-sahifa',
  'settings.privacy': '🔒 Rozilik va maʼlumotlar',
  'privacy.title': '🔒 Rozilik va maʼlumotlaringiz',
  'privacy.consentGiven':
    'Maʼlumotlarni qayta ishlashga rozilik {date} kuni berilgan ({version} tahriri).',
  'privacy.consentNone': 'Rozilik haqida yozuv topilmadi.',
  'privacy.doctors': '👩‍⚕️ Shifokorlarim',
  'privacy.withdraw': 'Rozilikni qaytarib olish',
  'privacy.delete': 'Maʼlumotlarimni oʻchirish',
  'privacy.hasRole.CLINICIAN':
    'Siz shifokor sifatida roʻyxatdan oʻtgansiz: bemorlarning kurslari sizga bogʻliq. Rozilikni qaytarib olish yoki maʼlumotlarni oʻchirish uchun avval xizmat administratoriga murojaat qiling.',
  'privacy.hasRole.STAFF':
    'Sizda xodim roli bor. Rozilikni qaytarib olish yoki maʼlumotlarni oʻchirish uchun avval administratordan rolni olib tashlashni soʻrang.',
  'privacy.doctorsNone': 'Hozir sizni hech bir shifokor kuzatmayapti.',
  'privacy.doctorsTitle': 'Shifokorlaringiz:',
  'privacy.doctorLine': '• {name} (shifokor)',
  'privacy.doctorLinePending': '• {name} — shifokor tasdigʻi kutilmoqda',
  'privacy.doctorLineShared': '• {name} — oldingi kurslaringiz xulosalarini koʻradi',
  'privacy.leaveButton': 'Uzilish: {name}',
  'privacy.shareButton': 'Oldingi kurslarni koʻrsatish: {name}',
  'privacy.unshareButton': 'Oldingi kurslarni yashirish: {name}',
  'privacy.leaveAsk':
    'Shifokor {name} bilan aloqani uzasizmi?\n\nBu shifokor tayinlagan kurslar toʻxtatiladi: eslatmalar darhol tugaydi. Shifokor maʼlumotlaringizni koʻra olmaydi va bu haqda xabar oladi.\n\nShifokor bilan gaplashmasdan davolanishni toʻxtatmang.',
  'privacy.leaveYes': 'Ha, uzilaman',
  'privacy.left': 'Siz shifokor {name} bilan aloqani uzdingiz. Toʻxtatilgan kurslar: {count}.',
  'privacy.shared':
    'Shifokor {name} endi oldingi kurslaringizning qisqa xulosalarini koʻradi: sanalar, dorilar va rioya qilish raqamlari. Xulosalarda izohlaringiz yoʻq.',
  'privacy.unshared': 'Shifokor {name} endi oldingi kurslaringiz xulosalarini koʻrmaydi.',
  'privacy.withdrawAsk':
    'Maʼlumotlarni qayta ishlashga rozilikni qaytarib olasizmi?\n\nBot siz uchun ishlamay qoladi: barcha kurslar toʻxtatiladi, eslatmalar tugaydi, shifokorlar va vasiylar maʼlumotlaringizni koʻra olmaydi. Maʼlumotlarning oʻzi oʻchirilmaydi: buning uchun alohida tugma bor. Rozilikni yana berish mumkin, lekin shifokorlarni qaytadan ulash kerak boʻladi.\n\nShifokor bilan gaplashmasdan davolanishni toʻxtatmang.',
  'privacy.withdrawYes': 'Ha, rozilikni qaytarib olaman',
  'privacy.withdrawn':
    'Rozilik qaytarib olindi. Kurslar toʻxtatildi, eslatmalar boʻlmaydi, shifokorlar maʼlumotlaringizni koʻrmaydi.\n\nBotdan yana foydalanish uchun rozilikni qaytadan bering.',
  'privacy.regrant': 'Rozilikni yana berish',
  'privacy.regranted':
    'Rozilik qabul qilindi. Shifokorlarni ularning havolalari orqali qaytadan ulash kerak.',
  'privacy.deleteAsk':
    'Maʼlumotlaringiz oʻchirilsinmi?\n\nDarhol: barcha kurslar toʻxtaydi, eslatmalar boʻlmaydi, shifokorlar va vasiylar maʼlumotlaringizni koʻra olmaydi.\n\n{days} kundan soʻng, {date}: ism, Telegram identifikatori va barcha izohlar tiklab boʻlmaydigan qilib oʻchiriladi. Shu kungacha soʻrovni bekor qilish mumkin.\n\nShifokor bilan gaplashmasdan davolanishni toʻxtatmang.',
  'privacy.deleteYes': 'Ha, maʼlumotlarim oʻchirilsin',
  'privacy.deletionPending':
    'Siz maʼlumotlaringizni oʻchirishni soʻradingiz. Ular {date} kuni oʻchiriladi. Shu kungacha soʻrovni bekor qilish mumkin.',
  'privacy.keep': 'Oʻchirishni bekor qilish',
  'privacy.kept': 'Oʻchirish soʻrovi bekor qilindi. Maʼlumotlar saqlab qolindi.',
  'privacy.doctorTold':
    'Bemor {name} siz bilan aloqani uzdi. Toʻxtatilgan kurslari: {count}. Uning maʼlumotlari endi sizga ochiq emas.',
  'past.button': '📚 Oldingi kurslar: {name}',
  'past.title': 'Bemorning oldingi kurslari (qisqa xulosalar)',
  'past.none':
    'Oldingi kurslar xulosalari hali yoʻq. Xulosa kurs tugaganidan uch kun oʻtgach paydo boʻladi.',
  'past.notShared': 'Bemor sizga oldingi kurslari xulosalarini ochmagan.',
  'past.course': '{started} — {ended}, {status}. Tayinlagan: {doctor}',
  'past.figure': 'Vaqtida qabul qilingan: {occurred} tadan {taken} tasi ({percent}%)',
  'past.figureNone': 'Vaqti kelgan qabullar boʻlmagan',
  'past.med': '• {name}, {dose}: vaqtida {occurred} tadan {taken} tasi',
  'past.medNoDose': '• {name}: vaqtida {occurred} tadan {taken} tasi',
  'past.prn': '• {name} (zaruratga qarab): belgilangan soni — {count}',
  'incident.notice': '⚠️ Hodisa: {what}.\n\nBatafsil — panelda: botga /panel yuboring.',
  'error.generic': 'Nimadir xato ketdi. Yana urinib koʻring yoki /start yuboring.',
  'error.unsupported':
    'Men faqat matn va tugmalarni tushunaman. Menyuni ochish uchun /menu yuboring.',
};
