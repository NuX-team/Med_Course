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

print(failures == 0 ? "ALL OK" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
