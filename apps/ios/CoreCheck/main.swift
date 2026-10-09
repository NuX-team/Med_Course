import Foundation

// Linux check of the app's core: models decode the API's real JSON, summaries add up.
// Run: swiftc ../MedCourse/Core/*.swift main.swift -o /tmp/core-check && /tmp/core-check

var failures = 0
func check(_ ok: Bool, _ what: String) {
    if ok { print("ok   \(what)") } else { print("FAIL \(what)"); failures += 1 }
}

let fixtures = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "fixtures")

func load<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
    guard let data = try? Data(contentsOf: fixtures.appendingPathComponent(name)) else {
        print("missing fixture \(name)"); failures += 1; return nil
    }
    do { return try JSON.decoder.decode(T.self, from: data) } catch {
        print("decode \(name): \(error)"); failures += 1; return nil
    }
}

if let today = load(TodayResponse.self, "today.json") {
    check(today.doses.count == 2, "today: two doses")
    let summary = TodaySummary(doses: today.doses, now: Date())
    check(summary.total == 2, "summary counts doses")
    check(summary.nextId == today.doses.first?.id, "next is the earliest open dose")
}
if let courses = load(CoursesResponse.self, "courses.json") {
    check(courses.courses.first?.medications.first?.times == ["08:00", "20:00"], "courses: times")
}
if let detail = load(CourseDetail.self, "course.json") {
    check(detail.course.doctor.firstName == "Rustam", "course: doctor")
}
if let me = load(Me.self, "me.json") { check(me.locale == "ru", "me: locale") }
if let answer = load(AnswerResponse.self, "take.json") { check(answer.dose.isTaken, "take: taken") }
if let days = load(DaysResponse.self, "days.json") { check(days.page == 1, "days: page") }
if let privacy = load(PrivacyResponse.self, "privacy.json") { check(privacy.doctors.first?.firstName == "Rustam", "privacy: doctors") }
if let preview = load(StartPreview.self, "start-preview.json") { check(!preview.canStart, "start preview") }

let strings = Strings(lang: .uz)
check(strings("action.take") == "Ichdim", "uz strings")
check(Set(Strings.ru.keys) == Set(Strings.uz.keys), "ru and uz have the same keys")
let format = Formatting(lang: .ru)
check(format.amount(value: 500, display: nil, unit: "MG", strings: Strings(lang: .ru)) == "500 мг", "amount")
check(format.amount(value: 0.5, display: "1/2", unit: "TABLET", strings: Strings(lang: .ru)) == "1/2 табл.", "amount display")
check(courseDay(firstDay: "2026-10-03", today: JSON.parseDate("2026-10-05T10:00:00Z")!, zone: "Asia/Tashkent") == 3, "course day")
check(JSON.parseDate("2026-10-03T03:00:00.000Z") != nil, "dates with milliseconds")

// Demo mode: every endpoint the app calls decodes, and answers change the state.
let demo = DemoBackend.shared
func demoGet<T: Decodable>(_ type: T.Type, _ method: String, _ path: String, _ body: [String: Any]? = nil) -> (Int, T?) {
    let data = body.flatMap { try? JSONSerialization.data(withJSONObject: $0) }
    let (status, out) = demo.respond(method: method, path: path, body: data)
    do { return (status, try JSON.decoder.decode(T.self, from: out)) } catch {
        print("demo decode \(method) \(path): \(error)"); failures += 1; return (status, nil)
    }
}
struct Any200: Decodable {}
check(demoGet(Me.self, "GET", "/v1/me").1?.firstName == "Farhod", "demo: me")
let demoToday = demoGet(TodayResponse.self, "GET", "/v1/today").1
check(demoToday?.doses.count == 4 && demoToday?.asNeeded.count == 1, "demo: today")
check(demoGet(CoursesResponse.self, "GET", "/v1/courses").1?.courses.count == 3, "demo: courses")
check(demoGet(CourseDetail.self, "GET", "/v1/courses/\(DemoBackend.activeId)").1?.report != nil, "demo: course + report")
check(demoGet(CourseDetail.self, "GET", "/v1/courses/\(DemoBackend.pendingId)").1?.course.status == "PENDING_PATIENT", "demo: pending")
check(demoGet(StartPreview.self, "GET", "/v1/courses/\(DemoBackend.pendingId)/start").1?.canStart == true, "demo: preview")
check(demoGet(StartResult.self, "POST", "/v1/courses/\(DemoBackend.pendingId)/start").1?.course.status == "ACTIVE", "demo: start")
check(demoGet(ChangeResponse.self, "GET", "/v1/courses/\(DemoBackend.activeId)/change").1?.change?.added.count == 1, "demo: change")
check(demoGet(Any200.self, "POST", "/v1/courses/\(DemoBackend.activeId)/change/accept").0 == 200, "demo: accept change")
check(demoGet(ChangeResponse.self, "GET", "/v1/courses/\(DemoBackend.activeId)/change").1?.change == nil, "demo: change gone")
check((demoGet(DaysResponse.self, "GET", "/v1/courses/\(DemoBackend.activeId)/days?page=1").1?.days.count ?? 0) == 2, "demo: days")
check(demoGet(PrivacyResponse.self, "GET", "/v1/privacy").1?.doctors.count == 2, "demo: privacy")
if let open = demoToday?.doses.first(where: { $0.isOpen && $0.scheduledAt.timeIntervalSinceNow < 3600 }) {
    check(demoGet(AnswerResponse.self, "POST", "/v1/doses/\(open.id)/take").1?.dose.isTaken == true, "demo: take")
    check(demoGet(AnswerResponse.self, "POST", "/v1/doses/\(open.id)/undo").1?.dose.isOpen == true, "demo: undo")
    check(demoGet(AnswerResponse.self, "POST", "/v1/doses/\(open.id)/skip", ["reason": "FORGOT"]).1?.dose.status == "SKIPPED", "demo: skip")
} else {
    print("note: no dose open right now, answer checks skipped")
}
if let later = demoGet(TodayResponse.self, "GET", "/v1/today").1?.doses.first(where: { $0.isOpen }) {
    check(demoGet(AnswerResponse.self, "POST", "/v1/doses/\(later.id)/snooze", ["minutes": 10]).1?.dose.status == "SNOOZED", "demo: snooze")
}
check(demoGet(Any200.self, "POST", "/v1/prn/\(DemoBackend.prnId)/take").0 == 200, "demo: prn take")
demo.reset()
check(demoGet(CourseDetail.self, "GET", "/v1/courses/\(DemoBackend.pendingId)").1?.course.status == "PENDING_PATIENT", "demo: reset")

print(failures == 0 ? "ALL OK" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
