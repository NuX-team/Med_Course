import Foundation

/// Demo mode: the whole API answered in memory with believable data, so every screen can be seen
/// without a server or an account. Answers change the in-memory state; nothing leaves the phone.
final class DemoBackend: @unchecked Sendable {
    static let shared = DemoBackend()

    static let activeId = "demo-course-active"
    static let pendingId = "demo-course-pending"
    static let pastId = "demo-course-past"
    static let prnId = "demo-med-ibuprofen"

    private let lock = NSLock()
    private let zone = "Asia/Tashkent"
    private var locale = "ru"
    private var doses: [DemoDose] = []
    private var pendingStartedAt: Date?
    private var changePending = true
    private var prnMarks: [Date] = []
    private var built = false

    private struct Med {
        let id: String
        let name: String
        let value: Double
        let unit: String
        let food: String
        let times: [String]
        var instructions: String? = nil
        var prn = false
        var max: Int? = nil
        var interval: Int? = nil
    }

    private struct DemoDose {
        let id: String
        let med: Med
        let scheduledAt: Date
        var status: String
        var answeredAt: Date?
        var skipReason: String?
        var snoozedUntil: Date?
        var deadlineAt: Date { scheduledAt.addingTimeInterval(30 * 60) }
    }

    private let amox = Med(
        id: "demo-med-amox", name: "Amoksiklav", value: 625, unit: "MG", food: "AFTER_MEAL",
        times: ["08:00", "14:00", "20:00"], instructions: "Запивать стаканом воды")
    private let vitD = Med(
        id: "demo-med-vitd", name: "Vitamin D3", value: 2000, unit: "IU", food: "WITH_MEAL", times: ["08:00"])
    private let ibuprofen = Med(
        id: DemoBackend.prnId, name: "Ibuprofen", value: 400, unit: "MG", food: "AFTER_MEAL", times: [],
        prn: true, max: 3, interval: 360)
    private let magnesium = Med(
        id: "demo-med-mg", name: "Magniy B6", value: 1, unit: "TABLET", food: "WITH_MEAL", times: ["13:00"])
    private let omeprazole = Med(
        id: "demo-med-omez", name: "Omeprazol", value: 20, unit: "MG", food: "BEFORE_MEAL", times: ["07:30"])
    private let azithro = Med(
        id: "demo-med-azi", name: "Azitromitsin", value: 500, unit: "MG", food: "BEFORE_MEAL", times: ["09:00"])

    func reset() {
        lock.lock()
        defer { lock.unlock() }
        built = false
        pendingStartedAt = nil
        changePending = true
        prnMarks = []
        locale = "ru"
    }

    // MARK: Entry

    func respond(method: String, path: String, body: Data?, now: Date = Date()) -> (Int, Data) {
        lock.lock()
        defer { lock.unlock() }
        if !built {
            build(now)
            built = true
        }
        let clean = path.split(separator: "?").first.map(String.init) ?? path
        let parts = Array(clean.split(separator: "/").map(String.init).dropFirst())
        let input = body.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? [:]
        let (status, object) = route(method, parts, input, now)
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return (status, data)
    }

    private func route(_ method: String, _ p: [String], _ input: [String: Any], _ now: Date) -> (Int, Any) {
        let ok: (Int, Any) = (200, ["ok": true])
        switch (method, p.count, p.first ?? "") {
        case ("GET", 1, "me"):
            return (200, me())
        case ("PATCH", 1, "me"):
            if let value = input["locale"] as? String, value == "ru" || value == "uz" { locale = value }
            return (200, me())
        case ("POST", 2, "me"), ("POST", 2, "auth"):
            return ok
        case ("GET", 1, "today"):
            return (200, ["doses": doses.sorted { $0.scheduledAt < $1.scheduledAt }.map { json($0, now) },
                          "asNeeded": [prnItem(now)]])
        case ("GET", 1, "courses"):
            return (200, ["courses": [course(Self.activeId, now), course(Self.pendingId, now), course(Self.pastId, now)]])
        case ("GET", 2, "courses"):
            guard [Self.activeId, Self.pendingId, Self.pastId].contains(p[1]) else { return notFound() }
            var detail = course(p[1], now)
            detail["report"] = report(p[1])
            return (200, detail)
        case ("GET", 3, "courses") where p[2] == "start":
            return (200, preview(p[1], now))
        case ("POST", 3, "courses") where p[2] == "start":
            guard p[1] == Self.pendingId, pendingStartedAt == nil else {
                return (409, ["error": "already_started", "course": course(p[1], now)])
            }
            pendingStartedAt = now
            return (200, ["course": course(p[1], now), "outlook": outlook(now)])
        case ("GET", 3, "courses") where p[2] == "change":
            guard p[1] == Self.activeId, changePending else { return (200, ["change": NSNull()]) }
            return (200, ["change": [
                "medications": [amox, vitD, ibuprofen, magnesium].map { med($0) },
                "added": [med(magnesium)],
                "removed": [Any](),
            ]])
        case ("POST", 4, "courses") where p[2] == "change":
            guard changePending else { return (409, ["error": "nothing_pending"]) }
            changePending = false
            return (200, ["course": course(p[1], now), "nextDoseAt": NSNull()])
        case ("POST", 3, "courses") where p[2] == "pause-request":
            return (200, ["status": "requested"])
        case ("GET", 3, "courses") where p[2] == "days":
            return (200, days(p[1], now))
        case ("GET", 2, "doses"):
            guard let dose = doses.first(where: { $0.id == p[1] }) else { return notFound() }
            return (200, ["dose": json(dose, now)])
        case ("POST", 3, "doses"):
            return answer(p[1], p[2], input, now)
        case ("POST", 3, "prn"):
            prnMarks.append(now)
            let over = prnMarks.filter { now.timeIntervalSince($0) < 86_400 }.count > (ibuprofen.max ?? 3)
            return (200, ["result": "RECORDED", "overLimit": over, "item": prnItem(now)])
        case ("POST", 4, "prn"):
            guard !prnMarks.isEmpty else { return (409, ["error": "not_correctable"]) }
            prnMarks.removeLast()
            return (200, ["result": "UNDONE", "item": prnItem(now)])
        case ("GET", 1, "privacy"):
            return (200, [
                "consent": ["version": "2026-10-v1", "at": iso(now.addingTimeInterval(-40 * 86_400))],
                "decision": "GRANTED",
                "deletionDueAt": NSNull(),
                "doctors": [
                    ["relationshipId": "demo-rel-1", "firstName": "Rustam", "lastName": "Tursunov",
                     "status": "ACTIVE", "sharesHistory": true],
                    ["relationshipId": "demo-rel-2", "firstName": "Dilnoza", "lastName": "Karimova",
                     "status": "ACTIVE", "sharesHistory": false],
                ],
                "heldRole": NSNull(),
            ])
        case ("POST", 2, "privacy"):
            return ok
        default:
            return notFound()
        }
    }

    private func notFound() -> (Int, Any) { (404, ["error": "not_found"]) }

    // MARK: Today

    private func build(_ now: Date) {
        let plan: [(Int, Int, Med)] = [(8, 0, amox), (8, 0, vitD), (14, 0, amox), (20, 0, amox)]
        doses = plan.enumerated().map { index, item in
            let scheduled = at(item.0, item.1, now: now)
            var dose = DemoDose(id: "demo-dose-\(index + 1)", med: item.2, scheduledAt: scheduled, status: "SCHEDULED")
            if now > dose.deadlineAt {
                if item.2.id == vitD.id {
                    dose.status = "SKIPPED"
                    dose.skipReason = "FORGOT"
                } else {
                    dose.status = "TAKEN"
                }
                dose.answeredAt = scheduled.addingTimeInterval(4 * 60)
            } else if now >= scheduled {
                dose.status = "NOTIFIED"
            }
            return dose
        }
        prnMarks = [now.addingTimeInterval(-5 * 3600)]
    }

    private func answer(_ id: String, _ action: String, _ input: [String: Any], _ now: Date) -> (Int, Any) {
        guard let index = doses.firstIndex(where: { $0.id == id }) else { return notFound() }
        var dose = doses[index]
        let open = ["SCHEDULED", "NOTIFIED", "SNOOZED"].contains(dose.status)
        switch action {
        case "take":
            guard open || dose.status == "MISSED" else {
                return (200, ["result": "ALREADY", "dose": json(dose, now)])
            }
            if now < dose.scheduledAt.addingTimeInterval(-3600) {
                return (409, ["error": "too_early", "dose": json(dose, now)])
            }
            dose.status = now > dose.deadlineAt ? "TAKEN_LATE" : "TAKEN"
            dose.answeredAt = now
            dose.snoozedUntil = nil
        case "skip":
            guard open else { return (200, ["result": "ALREADY", "dose": json(dose, now)]) }
            dose.status = "SKIPPED"
            dose.skipReason = (input["reason"] as? String) ?? "OTHER"
            dose.answeredAt = now
        case "snooze":
            guard open else { return (409, ["error": "snooze_not_allowed", "dose": json(dose, now)]) }
            let minutes = (input["minutes"] as? Int) ?? 10
            dose.status = "SNOOZED"
            dose.snoozedUntil = now.addingTimeInterval(Double(minutes) * 60)
        case "undo":
            guard let answered = dose.answeredAt, now < answered.addingTimeInterval(3600) else {
                return (409, ["error": "not_correctable", "dose": json(dose, now)])
            }
            dose.status = now > dose.deadlineAt ? "MISSED" : (now >= dose.scheduledAt ? "NOTIFIED" : "SCHEDULED")
            dose.answeredAt = nil
            dose.skipReason = nil
        default:
            return notFound()
        }
        doses[index] = dose
        return (200, ["result": "DONE", "dose": json(dose, now)])
    }

    private func json(_ dose: DemoDose, _ now: Date) -> [String: Any] {
        let open = ["SCHEDULED", "NOTIFIED", "SNOOZED"].contains(dose.status)
        let correctable = dose.answeredAt.map { $0.addingTimeInterval(3600) }
        return [
            "id": dose.id,
            "courseId": Self.activeId,
            "timezone": zone,
            "scheduledAt": iso(dose.scheduledAt),
            "deadlineAt": iso(dose.deadlineAt),
            "status": dose.status,
            "answeredAt": iso(dose.answeredAt),
            "correctableUntil": iso(correctable),
            "skipReason": dose.skipReason ?? NSNull(),
            "snoozedUntil": iso(dose.snoozedUntil),
            "snoozeOptions": open ? [5, 10, 15] : [Int](),
            "canAnswer": open || dose.status == "MISSED",
            "medication": [
                "displayName": dose.med.name,
                "doseValue": dose.med.value,
                "doseDisplay": NSNull(),
                "doseUnit": dose.med.unit,
                "foodRule": dose.med.food,
            ],
        ]
    }

    private func prnItem(_ now: Date) -> [String: Any] {
        let recent = prnMarks.filter { now.timeIntervalSince($0) < 86_400 }
        let last = recent.last
        let undoable: Any = last.flatMap { mark -> [String: Any]? in
            now.timeIntervalSince(mark) < 3600 ? ["eventId": "demo-prn-event", "until": iso(mark.addingTimeInterval(3600))] : nil
        } ?? NSNull()
        return [
            "medicationId": ibuprofen.id,
            "courseId": Self.activeId,
            "timezone": zone,
            "displayName": ibuprofen.name,
            "doseValue": ibuprofen.value,
            "doseDisplay": NSNull(),
            "doseUnit": ibuprofen.unit,
            "foodRule": ibuprofen.food,
            "maxDailyDoses": ibuprofen.max ?? 3,
            "minimumIntervalMinutes": ibuprofen.interval ?? 360,
            "takenInDay": recent.count,
            "lastTakenAt": iso(last),
            "undoable": undoable,
            "overLimit": recent.count >= (ibuprofen.max ?? 3),
            "withinLimitsFrom": iso(now),
        ]
    }

    // MARK: Courses

    private func med(_ med: Med) -> [String: Any] {
        [
            "id": med.id,
            "lineId": med.id,
            "displayName": med.name,
            "doseValue": med.value,
            "doseDisplay": NSNull(),
            "doseUnit": med.unit,
            "foodRule": med.food,
            "instructions": med.instructions ?? NSNull(),
            "asNeeded": med.prn,
            "maxDailyDoses": med.max ?? NSNull(),
            "minimumIntervalMinutes": med.interval ?? NSNull(),
            "activeFromDay": 1,
            "activeToDay": 10,
            "times": med.times,
        ]
    }

    private func adherence(_ taken: Int, _ late: Int, _ skipped: Int, _ missed: Int) -> [String: Any] {
        let occurred = taken + late + skipped + missed
        return [
            "taken": taken, "takenLate": late, "skipped": skipped, "missed": missed, "occurred": occurred,
            "percent": occurred == 0 ? NSNull() : (Double(taken) / Double(occurred) * 1000).rounded() / 10,
        ]
    }

    private func course(_ id: String, _ now: Date) -> [String: Any] {
        let day = 86_400.0
        switch id {
        case Self.activeId:
            return [
                "id": id, "status": "ACTIVE", "timezone": zone, "durationDays": 10,
                "startWindowFrom": iso(now.addingTimeInterval(-5 * day)), "startWindowTo": iso(now.addingTimeInterval(2 * day)),
                "startedAt": iso(now.addingTimeInterval(-2 * day)), "firstDay": localDate(now.addingTimeInterval(-2 * day)),
                "endedAt": NSNull(), "sentAt": iso(now.addingTimeInterval(-5 * day)),
                "doctor": ["firstName": "Rustam", "lastName": "Tursunov"],
                "medications": [amox, vitD, ibuprofen].map { med($0) },
                "pauses": [Any](), "changePending": changePending,
                "adherence": adherence(6, 1, 1, 0),
            ]
        case Self.pendingId:
            let started = pendingStartedAt
            return [
                "id": id, "status": started == nil ? "PENDING_PATIENT" : "ACTIVE", "timezone": zone, "durationDays": 14,
                "startWindowFrom": iso(now.addingTimeInterval(-day)), "startWindowTo": iso(now.addingTimeInterval(6 * day)),
                "startedAt": iso(started), "firstDay": started.map { localDate($0) } ?? NSNull(),
                "endedAt": NSNull(), "sentAt": iso(now.addingTimeInterval(-day)),
                "doctor": ["firstName": "Dilnoza", "lastName": "Karimova"],
                "medications": [med(omeprazole)],
                "pauses": [Any](), "changePending": false,
                "adherence": started == nil ? NSNull() : adherence(0, 0, 0, 0),
            ]
        default:
            return [
                "id": id, "status": "COMPLETED", "timezone": zone, "durationDays": 7,
                "startWindowFrom": iso(now.addingTimeInterval(-42 * day)), "startWindowTo": iso(now.addingTimeInterval(-35 * day)),
                "startedAt": iso(now.addingTimeInterval(-40 * day)), "firstDay": localDate(now.addingTimeInterval(-40 * day)),
                "endedAt": iso(now.addingTimeInterval(-33 * day)), "sentAt": iso(now.addingTimeInterval(-42 * day)),
                "doctor": ["firstName": "Dilnoza", "lastName": "Karimova"],
                "medications": [med(azithro)],
                "pauses": [Any](), "changePending": false,
                "adherence": adherence(6, 0, 1, 0),
            ]
        }
    }

    private func report(_ id: String) -> Any {
        switch id {
        case Self.activeId:
            return [
                "byMedication": [
                    ["lineId": amox.id, "displayName": amox.name, "adherence": adherence(5, 1, 0, 0)],
                    ["lineId": vitD.id, "displayName": vitD.name, "adherence": adherence(1, 0, 1, 0)],
                ],
                "skipReasons": ["FORGOT": 1, "NO_MEDICATION": 0, "OTHER": 0],
            ]
        case Self.pastId:
            return [
                "byMedication": [["lineId": azithro.id, "displayName": azithro.name, "adherence": adherence(6, 0, 1, 0)]],
                "skipReasons": ["FORGOT": 0, "NO_MEDICATION": 1, "OTHER": 0],
            ]
        default:
            return NSNull()
        }
    }

    private func preview(_ id: String, _ now: Date) -> [String: Any] {
        guard id == Self.pendingId, pendingStartedAt == nil else { return ["canStart": false, "refusal": "ALREADY_STARTED"] }
        return ["canStart": true, "outlook": outlook(now)]
    }

    private func outlook(_ now: Date) -> [String: Any] {
        [
            "firstDay": localDate(now), "lastDay": localDate(now.addingTimeInterval(13 * 86_400)),
            "dosesToday": 0, "plannedPerDay": 1, "dosesTotal": 13,
            "firstDoseAt": iso(at(7, 30, dayOffset: 1, now: now)),
        ]
    }

    private func days(_ id: String, _ now: Date) -> [String: Any] {
        var result: [[String: Any]] = []
        let entries: [(Med, Int, Int, String, String?)]
        switch id {
        case Self.activeId:
            entries = [(amox, 8, 0, "TAKEN", nil), (vitD, 8, 0, "TAKEN", nil), (amox, 14, 0, "TAKEN_LATE", nil),
                       (amox, 20, 0, "TAKEN", nil)]
        case Self.pastId:
            entries = [(azithro, 9, 0, "TAKEN", nil)]
        default:
            entries = []
        }
        if !entries.isEmpty {
            for offset in 1...2 {
                let date = now.addingTimeInterval(Double(-offset) * 86_400)
                result.append([
                    "date": localDate(date),
                    "entries": entries.enumerated().map { index, entry -> [String: Any] in
                        let missedOne = offset == 2 && index == 1
                        return [
                            "at": iso(at(entry.1, entry.2, dayOffset: -offset, now: now)),
                            "displayName": entry.0.name, "doseValue": entry.0.value, "doseDisplay": NSNull(),
                            "doseUnit": entry.0.unit,
                            "status": missedOne ? "SKIPPED" : entry.3,
                            "skipReason": missedOne ? "FORGOT" as Any : (entry.4.map { $0 as Any } ?? NSNull()),
                        ]
                    },
                ])
            }
        }
        return ["page": 1, "pages": 1, "days": result]
    }

    private func me() -> [String: Any] {
        ["id": "demo-user", "firstName": "Farhod", "lastName": "Demo", "locale": locale, "timezone": zone,
         "consent": "GRANTED", "deletionDueAt": NSNull()]
    }

    // MARK: Time

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone) ?? .current
        return calendar
    }

    private func at(_ hour: Int, _ minute: Int, dayOffset: Int = 0, now: Date) -> Date {
        let start = calendar.startOfDay(for: now)
        return calendar.date(byAdding: DateComponents(day: dayOffset, hour: hour, minute: minute), to: start) ?? now
    }

    private func iso(_ date: Date?) -> Any {
        guard let date else { return NSNull() }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func localDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: zone)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
