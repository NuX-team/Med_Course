import SwiftUI

struct CoursesView: View {
    @EnvironmentObject private var state: AppState
    @State private var courses: [Course]?
    @State private var failed = false

    private let current: Set<String> = ["PENDING_PATIENT", "ACTIVE", "PAUSED"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let courses {
                    if courses.isEmpty {
                        EmptyState(icon: "cross.case", title: state.t("courses.empty.title"), text: state.t("courses.empty.text"))
                            .card()
                    }
                    let now = courses.filter { current.contains($0.status) }
                    let past = courses.filter { !current.contains($0.status) }
                    if !now.isEmpty { section("courses.current", now) }
                    if !past.isEmpty { section("courses.past", past) }
                } else if failed {
                    SecondaryButton(title: state.t("action.retry"), icon: "arrow.clockwise") { Task { await load() } }
                } else {
                    ForEach(0..<2, id: \.self) { _ in SkeletonCard() }
                }
            }
            .padding(18)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(state.t("courses.title"))
        .refreshable { await load() }
        .task { await load() }
        .navigationDestination(for: Course.self) { CourseDetailView(courseId: $0.id) }
    }

    private func section(_ key: String, _ list: [Course]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(state.t(key)).font(.title3.weight(.semibold)).padding(.top, 4)
            ForEach(list) { course in
                NavigationLink(value: course) { CourseCard(course: course) }
                    .buttonStyle(PressableStyle())
            }
        }
    }

    private func load() async {
        do {
            let fresh = try await state.api.courses()
            withAnimation(.spring(response: 0.5, dampingFraction: 0.85)) { courses = fresh; failed = false }
        } catch {
            if courses == nil { failed = true }
            state.fail(error)
        }
    }
}

struct CourseCard: View {
    @EnvironmentObject private var state: AppState
    let course: Course

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                StatusPill(text: state.t.courseStatus(course.status), color: Theme.courseColor(course.status))
                if course.changePending {
                    StatusPill(text: state.t("course.changeTitle"), color: Theme.warning)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            Text(String(format: state.t("course.from"), state.format.dayMonth(course.sentAt, zone: course.timezone)))
                .font(.headline).foregroundStyle(.primary)
            Text(course.medications.map(\.displayName).joined(separator: " · "))
                .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            HStack(spacing: 14) {
                Label(course.doctor.fullName, systemImage: "stethoscope")
                Label(String(format: state.t("course.days"), course.durationDays), systemImage: "calendar")
                if let percent = course.adherence?.percent {
                    Label("\(Int(percent.rounded()))%", systemImage: "chart.bar.fill")
                        .foregroundStyle(percent >= 80 ? Theme.success : Theme.warning)
                }
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            if course.status == "ACTIVE", let day = courseDay(firstDay: course.firstDay, today: Date(), zone: course.timezone) {
                let fraction = min(1, Double(day) / Double(max(course.durationDays, 1)))
                VStack(alignment: .leading, spacing: 6) {
                    Text(String(format: state.t("course.day"), min(day, course.durationDays), course.durationDays))
                        .font(.caption.weight(.semibold)).foregroundStyle(Theme.accent)
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.accentSoft)
                            Capsule().fill(Theme.gradient).frame(width: proxy.size.width * fraction)
                        }
                    }
                    .frame(height: 6)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

struct CourseDetailView: View {
    @EnvironmentObject private var state: AppState
    let courseId: String
    @State private var detail: CourseDetail?
    @State private var change: ChangeInfo?
    @State private var preview: StartPreview?
    @State private var confirmStart = false
    @State private var confirmPause = false
    @State private var busy = false

    var body: some View {
        ScrollView {
            if let course = detail?.course {
                VStack(alignment: .leading, spacing: 16) {
                    hero(course)
                    if course.status == "PENDING_PATIENT" { startCard(course) }
                    if let change { changeCard(change) }
                    if let adherence = course.adherence, adherence.occurred > 0 { adherenceCard(adherence) }
                    medications(course)
                    if course.status != "PENDING_PATIENT" {
                        NavigationLink {
                            HistoryView(courseId: course.id, zone: course.timezone)
                        } label: {
                            HStack {
                                Label(state.t("course.history"), systemImage: "calendar.badge.clock")
                                Spacer()
                                Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                            }
                            .font(.body.weight(.medium))
                            .card()
                        }
                        .buttonStyle(PressableStyle())
                    }
                    if course.status == "ACTIVE" {
                        SecondaryButton(title: state.t("course.pause"), icon: "pause.circle", color: Theme.warning) {
                            confirmPause = true
                        }
                    }
                }
                .padding(18)
            } else {
                VStack { ForEach(0..<3, id: \.self) { _ in SkeletonCard() } }.padding(18)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $confirmStart) { startSheet.presentationDetents([.medium]).presentationCornerRadius(28) }
        .sheet(isPresented: $confirmPause) { pauseSheet.presentationDetents([.fraction(0.4)]).presentationCornerRadius(28) }
    }

    private func hero(_ course: Course) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            StatusPill(text: state.t.courseStatus(course.status), color: .white)
            Text(String(format: state.t("course.from"), state.format.dayMonth(course.sentAt, zone: course.timezone)))
                .font(.system(size: 28, weight: .bold, design: .rounded))
            HStack(spacing: 16) {
                Label(course.doctor.fullName, systemImage: "stethoscope")
                Label(String(format: state.t("course.days"), course.durationDays), systemImage: "calendar")
            }
            .font(.subheadline.weight(.medium))
            .opacity(0.9)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(22)
        .background(Theme.gradient, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .shadow(color: Theme.accent.opacity(0.3), radius: 20, y: 10)
    }

    private func startCard(_ course: Course) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let to = course.startWindowTo {
                Text(String(format: state.t("course.startBy"), state.format.dateTime(to, zone: course.timezone)))
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if let refusal = preview?.refusal {
                Text(state.t("refusal.\(refusal)")).font(.subheadline).foregroundStyle(Theme.danger)
            } else {
                PrimaryButton(title: state.t("course.start"), icon: "play.fill", busy: busy) { confirmStart = true }
            }
        }
        .card()
    }

    private var startSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(state.t("course.startConfirm")).font(.title3.weight(.bold))
            if let outlook = preview?.outlook {
                Text(String(format: state.t("course.startDetails"),
                            state.format.localDate(outlook.firstDay), state.format.localDate(outlook.lastDay),
                            outlook.dosesToday, outlook.dosesTotal))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            PrimaryButton(title: state.t("course.start"), icon: "play.fill", busy: busy) { Task { await start() } }
            Button(state.t("action.cancel")) { confirmStart = false }.frame(maxWidth: .infinity)
        }
        .padding(24)
    }

    private var pauseSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(state.t("course.pause")).font(.title3.weight(.bold))
            Text(state.t("course.pauseText")).foregroundStyle(.secondary)
            Spacer()
            PrimaryButton(title: state.t("course.pause"), icon: "paperplane.fill", color: Theme.warning, busy: busy) {
                Task { await requestPause() }
            }
        }
        .padding(24)
    }

    private func changeCard(_ change: ChangeInfo) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(state.t("course.changeTitle"), systemImage: "arrow.triangle.2.circlepath")
                .font(.headline).foregroundStyle(Theme.warning)
            Text(state.t("course.changeText")).font(.subheadline).foregroundStyle(.secondary)
            ForEach(change.added) { line in
                Label("\(state.t("course.added")): \(line.displayName)", systemImage: "plus.circle.fill")
                    .foregroundStyle(Theme.success).font(.subheadline)
            }
            ForEach(change.removed) { line in
                Label("\(state.t("course.removed")): \(line.displayName)", systemImage: "minus.circle.fill")
                    .foregroundStyle(Theme.danger).font(.subheadline)
            }
            PrimaryButton(title: state.t("course.changeAccept"), icon: "checkmark", busy: busy) {
                Task { await acceptChange() }
            }
        }
        .card()
    }

    private func adherenceCard(_ adherence: AdherenceInfo) -> some View {
        HStack(spacing: 18) {
            ZStack {
                ProgressRing(fraction: (adherence.percent ?? 0) / 100, lineWidth: 10, color: Theme.success)
                Text("\(Int((adherence.percent ?? 0).rounded()))%").font(.headline.monospacedDigit())
            }
            .frame(width: 78, height: 78)
            VStack(alignment: .leading, spacing: 6) {
                Text(state.t("course.adherence")).font(.headline)
                stat("course.taken", adherence.taken, Theme.success)
                stat("course.late", adherence.takenLate, Theme.warning)
                stat("course.skipped", adherence.skipped, Theme.danger)
                stat("course.missed", adherence.missed, .secondary)
            }
            Spacer()
        }
        .card()
    }

    private func stat(_ key: String, _ value: Int, _ color: Color) -> some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(state.t(key)).font(.caption).foregroundStyle(.secondary)
            Text("\(value)").font(.caption.weight(.semibold).monospacedDigit())
        }
    }

    private func medications(_ course: Course) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(state.t("course.medications")).font(.title3.weight(.semibold))
            ForEach(course.medications) { medication in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(medication.displayName).font(.headline)
                        Spacer()
                        Text(state.format.amount(value: medication.doseValue, display: medication.doseDisplay, unit: medication.doseUnit, strings: state.t))
                            .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accent)
                    }
                    Text(state.t.food(medication.foodRule)).font(.subheadline).foregroundStyle(.secondary)
                    if medication.asNeeded {
                        Text(String(format: state.t("course.asNeeded"), medication.maxDailyDoses ?? 0))
                            .font(.subheadline).foregroundStyle(.secondary)
                    } else {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(medication.times, id: \.self) { time in
                                    Text(time)
                                        .font(.caption.weight(.semibold).monospacedDigit())
                                        .padding(.horizontal, 10).padding(.vertical, 6)
                                        .background(Theme.accentSoft, in: Capsule())
                                        .foregroundStyle(Theme.accent)
                                }
                            }
                        }
                    }
                    if let instructions = medication.instructions, !instructions.isEmpty {
                        Text("\(state.t("course.instructions")): \(instructions)")
                            .font(.footnote).foregroundStyle(.secondary)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                .card()
            }
        }
    }

    private func load() async {
        do {
            let fresh = try await state.api.course(courseId)
            withAnimation(.spring(response: 0.5, dampingFraction: 0.85)) { detail = fresh }
            change = fresh.course.changePending ? try await state.api.change(courseId) : nil
            preview = fresh.course.status == "PENDING_PATIENT" ? try await state.api.startPreview(courseId) : nil
        } catch {
            state.fail(error)
        }
    }

    private func start() async {
        busy = true
        defer { busy = false }
        do {
            _ = try await state.api.start(courseId)
            confirmStart = false
            Haptics.success()
            state.show(state.t("course.started"))
            await load()
        } catch {
            confirmStart = false
            state.fail(error)
            await load()
        }
    }

    private func acceptChange() async {
        busy = true
        defer { busy = false }
        do {
            try await state.api.acceptChange(courseId)
            Haptics.success()
            await load()
        } catch {
            state.fail(error)
            await load()
        }
    }

    private func requestPause() async {
        busy = true
        defer { busy = false }
        do {
            let status = try await state.api.requestPause(courseId)
            confirmPause = false
            state.show(state.t(status == "already" ? "course.pauseAlready" : "course.pauseSent"))
        } catch {
            confirmPause = false
            state.fail(error)
        }
    }
}

struct HistoryView: View {
    @EnvironmentObject private var state: AppState
    let courseId: String
    let zone: String
    @State private var days: [HistoryDay] = []
    @State private var page = 0
    @State private var pages = 1
    @State private var loaded = false

    var body: some View {
        List {
            if loaded && days.isEmpty {
                Text(state.t("history.empty")).foregroundStyle(.secondary)
            }
            ForEach(days) { day in
                Section(state.format.weekdayDate(day.date)) {
                    ForEach(Array(day.entries.enumerated()), id: \.offset) { _, entry in
                        HStack(spacing: 12) {
                            Image(systemName: Theme.statusIcon(entry.status ?? "TAKEN"))
                                .foregroundStyle(entry.status == nil ? Theme.accent : Theme.statusColor(entry.status!))
                                .font(.title3)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.displayName).font(.body.weight(.medium))
                                Text(entry.status.map { state.t.doseStatus($0) } ?? state.t("history.prn"))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(state.format.time(entry.at, zone: zone))
                                .font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if page < pages && loaded {
                Button(state.t("history.older")) { Task { await loadMore() } }
            }
        }
        .navigationTitle(state.t("course.history"))
        .task { if !loaded { await loadMore() } }
    }

    private func loadMore() async {
        do {
            let next = try await state.api.days(courseId, page: page + 1)
            withAnimation { days += next.days }
            page = next.page
            pages = next.pages
            loaded = true
        } catch {
            state.fail(error)
        }
    }
}
