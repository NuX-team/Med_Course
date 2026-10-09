import Foundation

// Mirrors apps/api/src/views.ts. Dates arrive as ISO-8601 UTC; local dates as "YYYY-MM-DD".

struct Doctor: Codable, Hashable {
    let firstName: String
    let lastName: String
    var fullName: String { "\(firstName) \(lastName)" }
}

struct AdherenceInfo: Codable, Hashable {
    let taken: Int
    let takenLate: Int
    let skipped: Int
    let missed: Int
    let occurred: Int
    let percent: Double?
}

struct Medication: Codable, Hashable, Identifiable {
    let id: String
    let lineId: String
    let displayName: String
    let doseValue: Double
    let doseDisplay: String?
    let doseUnit: String
    let foodRule: String
    let instructions: String?
    let asNeeded: Bool
    let maxDailyDoses: Int?
    let minimumIntervalMinutes: Int?
    let activeFromDay: Int
    let activeToDay: Int
    let times: [String]
}

struct PauseInfo: Codable, Hashable {
    let from: Date
    let to: Date?
}

struct Course: Codable, Hashable, Identifiable {
    let id: String
    let status: String
    let timezone: String
    let durationDays: Int
    let startWindowFrom: Date?
    let startWindowTo: Date?
    let startedAt: Date?
    let firstDay: String?
    let endedAt: Date?
    let sentAt: Date
    let doctor: Doctor
    let medications: [Medication]
    let pauses: [PauseInfo]
    let changePending: Bool
    let adherence: AdherenceInfo?
}

struct MedicationLine: Codable, Hashable {
    let lineId: String
    let displayName: String
    let adherence: AdherenceInfo
}

struct SkipReasons: Codable, Hashable {
    let FORGOT: Int
    let NO_MEDICATION: Int
    let OTHER: Int
}

struct CourseReport: Codable, Hashable {
    let byMedication: [MedicationLine]
    let skipReasons: SkipReasons
}

struct CourseDetail: Codable, Hashable {
    let course: Course
    let report: CourseReport?

    init(from decoder: Decoder) throws {
        course = try Course(from: decoder)
        let container = try decoder.container(keyedBy: Keys.self)
        report = try container.decodeIfPresent(CourseReport.self, forKey: .report)
    }

    func encode(to encoder: Encoder) throws {
        try course.encode(to: encoder)
    }

    private enum Keys: String, CodingKey { case report }
}

struct DoseMedication: Codable, Hashable {
    let displayName: String
    let doseValue: Double
    let doseDisplay: String?
    let doseUnit: String
    let foodRule: String
}

struct Dose: Codable, Hashable, Identifiable {
    let id: String
    let courseId: String
    let timezone: String
    let scheduledAt: Date
    let deadlineAt: Date
    let status: String
    let answeredAt: Date?
    let correctableUntil: Date?
    let skipReason: String?
    let snoozedUntil: Date?
    let snoozeOptions: [Int]
    let canAnswer: Bool
    let medication: DoseMedication

    var isTaken: Bool { status == "TAKEN" || status == "TAKEN_LATE" }
    var isOpen: Bool { ["SCHEDULED", "NOTIFIED", "SNOOZED"].contains(status) }
}

struct Undoable: Codable, Hashable {
    let eventId: String
    let until: Date
}

struct PrnItem: Codable, Hashable, Identifiable {
    let medicationId: String
    let courseId: String
    let timezone: String
    let displayName: String
    let doseValue: Double
    let doseDisplay: String?
    let doseUnit: String
    let foodRule: String
    let maxDailyDoses: Int
    let minimumIntervalMinutes: Int
    let takenInDay: Int
    let lastTakenAt: Date?
    let undoable: Undoable?
    let overLimit: Bool
    let withinLimitsFrom: Date

    var id: String { medicationId }
}

struct TodayResponse: Codable {
    let doses: [Dose]
    let asNeeded: [PrnItem]
}

struct CoursesResponse: Codable {
    let courses: [Course]
}

struct Outlook: Codable, Hashable {
    let firstDay: String
    let lastDay: String
    let dosesToday: Int
    let plannedPerDay: Int
    let dosesTotal: Int
    let firstDoseAt: Date?
}

struct StartPreview: Codable {
    let canStart: Bool
    let outlook: Outlook?
    let refusal: String?
}

struct StartResult: Codable {
    let course: Course
    let outlook: Outlook
}

struct ChangeInfo: Codable, Hashable {
    let medications: [Medication]
    let added: [Medication]
    let removed: [Medication]
}

struct ChangeResponse: Codable {
    let change: ChangeInfo?
}

struct HistoryEntry: Codable, Hashable {
    let at: Date
    let displayName: String
    let doseValue: Double
    let doseDisplay: String?
    let doseUnit: String
    let status: String?
    let skipReason: String?
}

struct HistoryDay: Codable, Hashable, Identifiable {
    let date: String
    let entries: [HistoryEntry]
    var id: String { date }
}

struct DaysResponse: Codable {
    let page: Int
    let pages: Int
    let days: [HistoryDay]
}

struct AnswerResponse: Codable {
    let result: String
    let dose: Dose
}

struct Me: Codable, Hashable {
    let id: String
    let firstName: String
    let lastName: String
    let locale: String
    let timezone: String
    let consent: String
    let deletionDueAt: Date?
}

struct PrivacyDoctor: Codable, Hashable, Identifiable {
    let relationshipId: String
    let firstName: String
    let lastName: String
    let status: String
    let sharesHistory: Bool
    var id: String { relationshipId }
}

struct ConsentInfo: Codable, Hashable {
    let version: String
    let at: Date
}

struct PrivacyResponse: Codable {
    let consent: ConsentInfo?
    let decision: String
    let deletionDueAt: Date?
    let doctors: [PrivacyDoctor]
}

struct SignInStart: Codable {
    let botUrl: String
    let pollToken: String
    let expiresAt: Date
}

struct SignInPoll: Codable {
    let status: String
    let accessToken: String?
}

struct APIErrorBody: Codable {
    let error: String
}

enum JSON {
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = parseDate(text) { return date }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "not an ISO date: \(text)"))
        }
        return decoder
    }()

    static func parseDate(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: text)
    }
}
