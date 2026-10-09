import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var state: AppState
    @State private var confirmLogout = false

    var body: some View {
        List {
            if let me = state.me {
                Section {
                    HStack(spacing: 14) {
                        Text(String(me.firstName.prefix(1)) + String(me.lastName.prefix(1)))
                            .font(.title2.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 56, height: 56)
                            .background(Theme.gradient, in: Circle())
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(me.firstName) \(me.lastName)").font(.headline)
                            Text(me.timezone).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
            Section(state.t("settings.language")) {
                Picker(state.t("settings.language"), selection: Binding(
                    get: { state.lang },
                    set: { lang in Task { await state.changeLanguage(lang) } }
                )) {
                    ForEach(Lang.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            Section {
                Text(state.t("settings.remindersText")).font(.subheadline).foregroundStyle(.secondary)
                Button {
                    state.openBot()
                } label: {
                    Label(state.t("settings.openBot"), systemImage: "paperplane.fill")
                }
            } header: {
                Text(state.t("settings.reminders"))
            }
            Section {
                NavigationLink {
                    PrivacyView()
                } label: {
                    Label(state.t("settings.privacy"), systemImage: "lock.shield.fill")
                }
            }
            Section {
                Button(role: .destructive) {
                    confirmLogout = true
                } label: {
                    Label(state.t("settings.logout"), systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .navigationTitle(state.t("settings.title"))
        .sheet(isPresented: $confirmLogout) {
            VStack(alignment: .leading, spacing: 16) {
                Text(state.t("settings.logout")).font(.title3.weight(.bold))
                Text(state.t("settings.logoutConfirm")).foregroundStyle(.secondary)
                Spacer()
                PrimaryButton(title: state.t("settings.logout"), color: Theme.danger) {
                    confirmLogout = false
                    Task { await state.signOut() }
                }
                Button(state.t("action.cancel")) { confirmLogout = false }.frame(maxWidth: .infinity)
            }
            .padding(24)
            .presentationDetents([.fraction(0.35)])
            .presentationCornerRadius(28)
        }
    }
}

struct PrivacyView: View {
    @EnvironmentObject private var state: AppState
    @State private var privacy: PrivacyResponse?
    @State private var confirm: Action?
    @State private var busy = false

    enum Action: String, Identifiable {
        case withdraw, delete
        var id: String { rawValue }
    }

    var body: some View {
        List {
            if state.restricted {
                Section {
                    Text(state.t("privacy.restricted")).font(.subheadline)
                    Text(state.t("privacy.restoreInBot")).font(.subheadline).foregroundStyle(.secondary)
                    Button { state.openBot() } label: {
                        Label(state.t("settings.openBot"), systemImage: "paperplane.fill")
                    }
                }
            }
            if let privacy {
                if let consent = privacy.consent {
                    Section {
                        Label(
                            String(format: state.t("privacy.consentGiven"), state.format.dayMonth(consent.at, zone: state.me?.timezone ?? "Asia/Tashkent")),
                            systemImage: "checkmark.seal.fill"
                        )
                        .foregroundStyle(Theme.success)
                    }
                }
                if !privacy.doctors.isEmpty {
                    Section(state.t("privacy.doctors")) {
                        ForEach(privacy.doctors) { doctor in
                            Label("\(doctor.firstName) \(doctor.lastName)", systemImage: "stethoscope")
                        }
                    }
                }
                if let due = privacy.deletionDueAt {
                    Section {
                        Text(String(format: state.t("privacy.deletionDue"), state.format.dayMonth(due, zone: state.me?.timezone ?? "Asia/Tashkent")))
                        Button(state.t("privacy.cancelDeletion")) { Task { await cancelDeletion() } }
                    }
                } else {
                    Section {
                        if privacy.decision == "GRANTED" {
                            Button(state.t("privacy.withdraw"), role: .destructive) { confirm = .withdraw }
                        }
                        Button(state.t("privacy.delete"), role: .destructive) { confirm = .delete }
                    }
                }
            } else {
                ProgressView()
            }
            if state.restricted {
                Section {
                    Button(state.t("settings.logout"), role: .destructive) { Task { await state.signOut() } }
                }
            }
        }
        .navigationTitle(state.t("privacy.title"))
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $confirm) { action in
            VStack(alignment: .leading, spacing: 16) {
                Text(state.t(action == .withdraw ? "privacy.withdraw" : "privacy.delete")).font(.title3.weight(.bold))
                Text(state.t(action == .withdraw ? "privacy.withdrawText" : "privacy.deleteText"))
                    .foregroundStyle(.secondary)
                Spacer()
                PrimaryButton(
                    title: state.t(action == .withdraw ? "privacy.withdraw" : "privacy.delete"),
                    color: Theme.danger, busy: busy
                ) { Task { await perform(action) } }
                Button(state.t("action.cancel")) { confirm = nil }.frame(maxWidth: .infinity)
            }
            .padding(24)
            .presentationDetents([.medium])
            .presentationCornerRadius(28)
        }
    }

    private func load() async {
        do { privacy = try await state.api.privacy() } catch { state.fail(error) }
    }

    private func perform(_ action: Action) async {
        busy = true
        defer { busy = false }
        do {
            if action == .withdraw { try await state.api.withdrawConsent() } else { try await state.api.requestDeletion() }
            confirm = nil
            await state.refreshMe()
            await load()
        } catch {
            confirm = nil
            state.fail(error)
        }
    }

    private func cancelDeletion() async {
        do {
            try await state.api.cancelDeletion()
            await state.refreshMe()
            await load()
        } catch {
            state.fail(error)
        }
    }
}
