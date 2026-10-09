import SwiftUI

struct TodayView: View {
    @EnvironmentObject private var state: AppState
    @State private var today: TodayResponse?
    @State private var loading = true
    @State private var failed = false
    @State private var skipping: Dose?
    @State private var busyId: String?
    @State private var now = Date()

    private var zone: String { today?.doses.first?.timezone ?? state.me?.timezone ?? "Asia/Tashkent" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                if let today {
                    if today.doses.isEmpty && today.asNeeded.isEmpty {
                        EmptyState(
                            icon: "sun.haze.fill",
                            title: state.t("today.empty.title"),
                            text: state.t("today.empty.text")
                        )
                        .card()
                    } else {
                        let summary = TodaySummary(doses: today.doses, now: now)
                        if summary.total > 0 { progressCard(summary) }
                        ForEach(Array(today.doses.enumerated()), id: \.element.id) { index, dose in
                            DoseCard(
                                dose: dose,
                                isNext: dose.id == summary.nextId,
                                busy: busyId == dose.id,
                                onTake: { Task { await answer(dose) { try await state.api.take(dose.id) } } },
                                onSkip: { skipping = dose },
                                onSnooze: { minutes in
                                    Task { await answer(dose) { try await state.api.snooze(dose.id, minutes: minutes) } }
                                },
                                onUndo: { Task { await answer(dose) { try await state.api.undo(dose.id) } } }
                            )
                            .transition(.asymmetric(
                                insertion: .move(edge: .bottom).combined(with: .opacity),
                                removal: .opacity))
                            .animation(.spring(response: 0.5, dampingFraction: 0.85).delay(Double(index) * 0.04), value: today.doses)
                        }
                        if !today.asNeeded.isEmpty { asNeededSection(today.asNeeded) }
                    }
                } else if failed {
                    retry
                } else {
                    ForEach(0..<3, id: \.self) { _ in SkeletonCard() }
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 30)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(state.t("tab.today"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $skipping) { dose in
            SkipSheet(dose: dose) { reason, note in
                skipping = nil
                Task { await answer(dose) { try await state.api.skip(dose.id, reason: reason, note: note) } }
            }
            .presentationDetents([.medium])
            .presentationCornerRadius(28)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(state.format.weekdayDate(localToday))
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            Text("\(state.t(DayPart.of(now, zone: zone).greetingKey))\(state.me.map { ", \($0.firstName)" } ?? "")")
                .font(.system(size: 30, weight: .bold, design: .rounded))
        }
        .padding(.top, 8)
    }

    private var localToday: String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: zone)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: now)
    }

    private func progressCard(_ summary: TodaySummary) -> some View {
        HStack(spacing: 18) {
            ZStack {
                ProgressRing(fraction: summary.fraction, lineWidth: 9, color: summary.allDone ? Theme.success : Theme.accent)
                if summary.allDone {
                    Image(systemName: "checkmark").font(.title3.weight(.bold)).foregroundStyle(Theme.success)
                        .transition(.scale.combined(with: .opacity))
                } else {
                    Text("\(Int(summary.fraction * 100))%").font(.subheadline.weight(.bold).monospacedDigit())
                }
            }
            .frame(width: 66, height: 66)
            VStack(alignment: .leading, spacing: 4) {
                Text(String(format: state.t("today.progress"), summary.answered, summary.total))
                    .font(.headline)
                Text(summary.allDone ? state.t("today.allDone") : nextLine(summary))
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .card()
        .animation(.spring(), value: summary.allDone)
    }

    private func nextLine(_ summary: TodaySummary) -> String {
        guard let id = summary.nextId, let dose = today?.doses.first(where: { $0.id == id }) else { return "" }
        return "\(state.t("today.next")): \(state.format.time(dose.scheduledAt, zone: dose.timezone)) · \(dose.medication.displayName)"
    }

    private func asNeededSection(_ items: [PrnItem]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(state.t("today.asNeeded")).font(.title3.weight(.semibold)).padding(.top, 6)
            ForEach(items) { item in
                PrnCard(item: item, busy: busyId == item.id) {
                    Task { await takePrn(item) }
                } onUndo: { eventId in
                    Task { await undoPrn(item, eventId) }
                }
            }
        }
    }

    private var retry: some View {
        VStack(spacing: 14) {
            EmptyState(icon: "wifi.exclamationmark", title: state.t("error.network"), text: "")
            SecondaryButton(title: state.t("action.retry"), icon: "arrow.clockwise") { Task { await load() } }
        }
        .card()
    }

    private func load() async {
        now = Date()
        do {
            let fresh = try await state.api.today()
            withAnimation(.spring(response: 0.5, dampingFraction: 0.85)) {
                today = fresh
                failed = false
            }
        } catch {
            if today == nil { failed = true }
            state.fail(error)
        }
        loading = false
    }

    private func answer(_ dose: Dose, _ call: @escaping () async throws -> Dose) async {
        busyId = dose.id
        defer { busyId = nil }
        do {
            let updated = try await call()
            if updated.isTaken { Haptics.success() } else { Haptics.tap() }
            withAnimation(.spring(response: 0.45, dampingFraction: 0.8)) { replace(updated) }
        } catch {
            Haptics.warning()
            state.fail(error)
            await load()
        }
    }

    private func replace(_ dose: Dose) {
        guard let current = today, let index = current.doses.firstIndex(where: { $0.id == dose.id }) else { return }
        var doses = current.doses
        doses[index] = dose
        today = TodayResponse(doses: doses, asNeeded: current.asNeeded)
    }

    private func takePrn(_ item: PrnItem) async {
        busyId = item.id
        defer { busyId = nil }
        do {
            let over = try await state.api.takePrn(item.medicationId)
            Haptics.success()
            if over { state.show(state.t("prn.overLimit"), error: true) }
            await load()
        } catch {
            state.fail(error)
        }
    }

    private func undoPrn(_ item: PrnItem, _ eventId: String) async {
        busyId = item.id
        defer { busyId = nil }
        do {
            try await state.api.undoPrn(eventId)
            Haptics.tap()
            await load()
        } catch {
            state.fail(error)
        }
    }
}

struct DoseCard: View {
    @EnvironmentObject private var state: AppState
    let dose: Dose
    let isNext: Bool
    let busy: Bool
    let onTake: () -> Void
    let onSkip: () -> Void
    let onSnooze: (Int) -> Void
    let onUndo: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                VStack(spacing: 2) {
                    Text(state.format.time(dose.scheduledAt, zone: dose.timezone))
                        .font(.system(.title3, design: .rounded).weight(.bold).monospacedDigit())
                        .foregroundStyle(isNext ? Theme.accent : .primary)
                }
                .frame(width: 64, alignment: .leading)

                VStack(alignment: .leading, spacing: 4) {
                    Text(dose.medication.displayName).font(.headline)
                    Text("\(state.format.amount(value: dose.medication.doseValue, display: dose.medication.doseDisplay, unit: dose.medication.doseUnit, strings: state.t)) · \(state.t.food(dose.medication.foodRule))")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: Theme.statusIcon(dose.status))
                    .font(.title2)
                    .foregroundStyle(Theme.statusColor(dose.status))
                    .symbolRenderingMode(.hierarchical)
                    .contentTransition(.symbolEffect(.replace))
            }

            if dose.isOpen || dose.status == "MISSED" {
                actions
                    .transition(.opacity.combined(with: .move(edge: .top)))
            } else {
                HStack {
                    StatusPill(text: state.t.doseStatus(dose.status), color: Theme.statusColor(dose.status))
                    if let reason = dose.skipReason {
                        Text(state.t.reason(reason)).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let until = dose.correctableUntil, until > Date() {
                        Button(state.t("action.undo"), action: onUndo)
                            .font(.caption.weight(.semibold))
                    }
                }
            }
        }
        .card()
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                .stroke(isNext ? Theme.accent.opacity(0.5) : .clear, lineWidth: 1.5)
        )
        .opacity(busy ? 0.6 : 1)
        .allowsHitTesting(!busy)
    }

    private var actions: some View {
        VStack(spacing: 10) {
            PrimaryButton(
                title: state.t(dose.status == "MISSED" ? "action.takeLate" : "action.take"),
                icon: "checkmark",
                color: dose.status == "MISSED" ? Theme.warning : Theme.success,
                busy: busy,
                action: onTake
            )
            if dose.isOpen {
                HStack(spacing: 10) {
                    if !dose.snoozeOptions.isEmpty {
                        Menu {
                            ForEach(dose.snoozeOptions, id: \.self) { minutes in
                                Button(String(format: state.t("action.laterMinutes"), minutes)) { onSnooze(minutes) }
                            }
                        } label: {
                            Label(state.t("action.later"), systemImage: "alarm")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .foregroundStyle(Theme.warning)
                                .background(Theme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                    }
                    SecondaryButton(title: state.t("action.skip"), icon: "xmark", color: Theme.danger, action: onSkip)
                }
            }
        }
    }
}

struct PrnCard: View {
    @EnvironmentObject private var state: AppState
    let item: PrnItem
    let busy: Bool
    let onTake: () -> Void
    let onUndo: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.displayName).font(.headline)
                    Text(state.format.amount(value: item.doseValue, display: item.doseDisplay, unit: item.doseUnit, strings: state.t))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                Text(String(format: state.t("prn.count"), item.takenInDay, item.maxDailyDoses))
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(item.overLimit ? Theme.warning : .secondary)
            }
            HStack(spacing: 10) {
                SecondaryButton(title: state.t("prn.take"), icon: "plus.circle.fill", color: Theme.accent, action: onTake)
                if let undo = item.undoable, undo.until > Date() {
                    SecondaryButton(title: state.t("prn.undo"), icon: "arrow.uturn.backward", color: .secondary) {
                        onUndo(undo.eventId)
                    }
                }
            }
        }
        .card()
        .opacity(busy ? 0.6 : 1)
    }
}

struct SkipSheet: View {
    @EnvironmentObject private var state: AppState
    let dose: Dose
    let onSkip: (String, String?) -> Void
    @State private var reason = "FORGOT"
    @State private var note = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(state.t("skip.title")).font(.title3.weight(.bold))
            Text(dose.medication.displayName).foregroundStyle(.secondary)
            VStack(spacing: 10) {
                ForEach(["FORGOT", "NO_MEDICATION", "OTHER"], id: \.self) { code in
                    Button {
                        withAnimation(.spring(response: 0.3)) { reason = code }
                        Haptics.tap()
                    } label: {
                        HStack {
                            Text(state.t.reason(code)).foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: reason == code ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(reason == code ? Theme.accent : .secondary)
                        }
                        .padding(14)
                        .background(
                            (reason == code ? Theme.accentSoft : Color(.tertiarySystemFill)),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(PressableStyle())
                }
            }
            if reason == "OTHER" {
                TextField(state.t("skip.note"), text: $note, axis: .vertical)
                    .lineLimit(2...4)
                    .padding(14)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
            Spacer()
            PrimaryButton(title: state.t("skip.send"), color: Theme.danger) {
                onSkip(reason, reason == "OTHER" ? String(note.prefix(300)) : nil)
            }
        }
        .padding(24)
    }
}

struct SkeletonCard: View {
    @State private var shimmer = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            RoundedRectangle(cornerRadius: 6).frame(width: 140, height: 16)
            RoundedRectangle(cornerRadius: 6).frame(width: 220, height: 12)
            RoundedRectangle(cornerRadius: 12).frame(height: 44)
        }
        .foregroundStyle(Color(.tertiarySystemFill))
        .opacity(shimmer ? 0.5 : 1)
        .animation(.easeInOut(duration: 0.9).repeatForever(), value: shimmer)
        .card()
        .onAppear { shimmer = true }
    }
}
