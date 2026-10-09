import Foundation

/// Times shown in the course's own zone (the zone doses are scheduled in), in the person's language.
struct Formatting {
    let lang: Lang

    private func formatter(_ format: String, zone: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: lang.localeId)
        formatter.timeZone = TimeZone(identifier: zone) ?? .current
        formatter.dateFormat = format
        return formatter
    }

    func time(_ date: Date, zone: String) -> String {
        formatter("HH:mm", zone: zone).string(from: date)
    }

    func dayMonth(_ date: Date, zone: String) -> String {
        formatter("d MMMM", zone: zone).string(from: date)
    }

    func dateTime(_ date: Date, zone: String) -> String {
        formatter("d MMMM, HH:mm", zone: zone).string(from: date)
    }

    /// "2026-10-09" → "9 октября".
    func localDate(_ value: String) -> String {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = TimeZone(identifier: "UTC")
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: value) else { return value }
        return formatter("d MMMM", zone: "UTC").string(from: date)
    }

    func weekdayDate(_ value: String) -> String {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = TimeZone(identifier: "UTC")
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: value) else { return value }
        return formatter("EEEE, d MMMM", zone: "UTC").string(from: date).capitalizedFirst
    }

    /// "500 мг", "1/2 табл.": the doctor's own wording wins.
    func amount(value: Double, display: String?, unit: String, strings: Strings) -> String {
        let number: String
        if let display, !display.isEmpty {
            number = display
        } else if value.rounded() == value {
            number = String(Int(value))
        } else {
            number = String(format: "%g", value)
        }
        return "\(number) \(strings.unit(unit))"
    }
}

extension String {
    var capitalizedFirst: String {
        guard let first else { return self }
        return first.uppercased() + dropFirst()
    }
}

enum DayPart {
    case morning, day, evening

    static func of(_ date: Date, zone: String) -> DayPart {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone) ?? .current
        let hour = calendar.component(.hour, from: date)
        if hour >= 4 && hour < 12 { return .morning }
        if hour >= 12 && hour < 18 { return .day }
        return .evening
    }

    var greetingKey: String {
        switch self {
        case .morning: return "today.greeting.morning"
        case .day: return "today.greeting.day"
        case .evening: return "today.greeting.evening"
        }
    }
}

/// What the Today screen is built from: pure, so it is checked on Linux in tests.
struct TodaySummary: Equatable {
    let total: Int
    let answered: Int
    let nextId: String?

    init(doses: [Dose], now: Date) {
        let counted = doses.filter { $0.status != "SUPERSEDED" }
        total = counted.count
        answered = counted.filter { !$0.isOpen }.count
        nextId = counted
            .filter { $0.isOpen }
            .sorted { $0.scheduledAt < $1.scheduledAt }
            .first?.id
    }

    var fraction: Double { total == 0 ? 0 : Double(answered) / Double(total) }
    var allDone: Bool { total > 0 && answered == total }
}

/// Which day of the course today is, 1-based; nil before the start.
func courseDay(firstDay: String?, today: Date, zone: String) -> Int? {
    guard let firstDay else { return nil }
    let parser = DateFormatter()
    parser.locale = Locale(identifier: "en_US_POSIX")
    parser.timeZone = TimeZone(identifier: zone) ?? .current
    parser.dateFormat = "yyyy-MM-dd"
    guard let start = parser.date(from: firstDay) else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: zone) ?? .current
    let days = calendar.dateComponents(
        [.day], from: calendar.startOfDay(for: start), to: calendar.startOfDay(for: today)
    ).day ?? 0
    return days + 1
}
