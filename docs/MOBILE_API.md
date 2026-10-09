# MedCourse Mobile API v1 — contract (shared by apps/api and apps/ios)

Base: `https://<host>/v1`. JSON, UTF-8. All times ISO-8601 UTC; the client renders in `timezone` from the user.
Auth: `Authorization: Bearer <accessToken>` (opaque, 30 days, stored hashed server-side; revocable on logout).
Errors: `{ "error": "<code>", "message": "<human text in user's locale>" }` with HTTP 4xx/5xx. Codes are stable snake_case.

## Identity
Users already exist keyed by `telegram_user_id` (patients onboarded in the bot). The app logs in by **phone + SMS code**
(dev: code is returned in the response when `APP_ENV=local`; prod: sent via SMS provider or via the Telegram bot if the
phone is linked). Phone is stored encrypted (`patient_profiles.phone_enc`) and looked up by HMAC hash (`phone_hash`, new column).
If the phone matches an existing patient → same account (Telegram reminders keep working). If not → new account with
`telegram_user_id = null` (migration: make nullable, add `phone_hash`, `auth_sessions`, `sms_codes`, `device_tokens`).

## Endpoints

POST /v1/auth/request-code        { phone: "+998901234567", locale: "ru"|"uz" }  → { sent: true, ttlSec: 300, devCode?: "123456" }
POST /v1/auth/verify              { phone, code }                                  → { accessToken, user: User, isNew: bool }
POST /v1/auth/logout              —                                                → { ok: true }
GET  /v1/me                        → User
PATCH /v1/me                       { locale?, timezone?, firstName?, lastName? }   → User
POST /v1/me/consent                { granted: true, version: "v1" }                → User
POST /v1/me/device                 { platform: "ios", token: "<apns hex>" }        → { ok: true }   (stored for future push; reminders stay in Telegram)
GET  /v1/me/doctors                → { doctors: [{ relationshipId, status: "PENDING"|"ACTIVE", firstName, lastName }] }
POST /v1/me/doctors/:relationshipId/decide { accept: bool }                        → { status }
POST /v1/invitations/redeem        { code }                                        → { relationshipId, doctor: {firstName,lastName} }

GET  /v1/courses                   → { courses: [CourseCard] }      (PENDING_PATIENT + ACTIVE + PAUSED first, then history)
GET  /v1/courses/:id               → CourseDetail
POST /v1/courses/:id/start-preview → StartPreview  { canStart, refusal?, firstDoseAt?, dosesTotal }
POST /v1/courses/:id/start         → CourseDetail   (409 if cannot)
GET  /v1/courses/:id/change        → PendingChange | null
POST /v1/courses/:id/change/accept → CourseDetail
POST /v1/courses/:id/pause-request { } → { ok: true }    (asks the doctor; bot delivers)
GET  /v1/courses/:id/report        → CourseReport  (adherence totals, per medication, skip reasons)
GET  /v1/courses/:id/days?page=1   → { days: [DayView], page, pages }

GET  /v1/today                     → { date: "2026-10-09", timezone, doses: [Dose] }
GET  /v1/doses/:id                 → Dose
POST /v1/doses/:id/take            { }                     → Dose
POST /v1/doses/:id/skip            { reason: "FORGOT"|"NO_MEDICINE"|"OTHER", note?: string } → Dose
POST /v1/doses/:id/snooze          { minutes: 5|10|15 }    → Dose
POST /v1/doses/:id/undo            { }                     → Dose   (within correctableUntil)

GET  /v1/prn                       → { items: [PrnItem] }           (as-needed medications available now)
POST /v1/prn/:lineId/take          { } → { eventId }
POST /v1/prn/events/:eventId/undo  { } → { ok }

GET  /v1/privacy                   → PrivacyOverview
POST /v1/privacy/withdraw          { } → { ok }
POST /v1/privacy/delete-request    { } → { ok, eraseAt }
POST /v1/privacy/delete-cancel     { } → { ok }

## Types (TypeScript-ish; iOS mirrors with Codable)
User { id, firstName, lastName, phoneMasked, locale, timezone, consentGrantedAt: string|null, telegramLinked: bool }
CourseCard { id, status, title (e.g. "Курс от 3 окт"), doctor: {firstName,lastName}, startedAt?, endsAt?, dosesToday?: number, adherencePct?: number, medicationsPreview: [string] }
CourseDetail { id, status, timezone, doctor, medications: [Medication], startWindow?: {opensAt, closesAt}, startedAt?, endsAt?, pauses: [{from,to?}], change: PendingChange|null, adherence?: Adherence }
Medication { lineId, displayName, doseValue, doseDisplay?, doseUnit, foodRule, times: ["08:00","20:00"], intervalHours?, days?, note?, asNeeded: bool, maxPerDay? }
Dose { id, courseId, scheduledAt, deadlineAt, status: "SCHEDULED"|"NOTIFIED"|"SNOOZED"|"TAKEN"|"TAKEN_LATE"|"SKIPPED"|"MISSED"|"SUPERSEDED", displayName, doseDisplay, foodRule, answeredAt?, correctableUntil?, snoozedUntil?, snoozeOptions: [number], canAnswer: bool, skipReason? }
Adherence { due, taken, takenLate, skipped, missed, pct }
CourseReport { course: CourseCard, adherence, perMedication: [{lineId, displayName, adherence}], skipReasons: {FORGOT, NO_MEDICINE, OTHER}, prnTaken }
DayView { date, doses: [Dose] }
PendingChange { revisionId, sentAt, medications: [Medication], summary: string }
StartPreview { canStart, refusal?: "DOCTOR_UNAVAILABLE"|"RELATIONSHIP_ENDED"|"NO_DOSES"|"WINDOW_CLOSED", firstDoseAt?, dosesTotal }
PrnItem { lineId, displayName, doseDisplay, takenToday, maxPerDay?, lastTakenAt? }
PrivacyOverview { consentGrantedAt?, doctors: [...], deletionRequestedAt?, eraseAt? }

## Rules the API must keep (from CONTEXT.md §4)
- Every repository call goes through the existing `Repositories` with `{kind:'PATIENT', userId}` actor. No raw SQL in the API app.
- "Cannot read" == 404, same as not-found. ForbiddenError → 403 only for role violations.
- Idempotent answers: `take/skip/snooze` use an `Idempotency-Key` header (uuid) mapped to `Incoming.key` semantics.
- No parse_mode, no HTML: plain strings. Locale from user, fallback `Accept-Language`.
- Rate limit: 60 req/min per token, 5 code requests per phone per hour, 5 verify attempts per code.
- Telegram keeps delivering reminders; the API never sends Telegram messages itself except via existing repos (pause-request).
