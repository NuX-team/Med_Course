import SwiftUI

/// Sign-in by confirming in the bot: no password, no SMS. The app opens
/// t.me/<bot>?start=a_<code>, the person presses "Confirm", the app polls until it is let in.
struct SignInView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.scenePhase) private var scenePhase
    @State private var pending: SignInStart?
    @State private var busy = false
    @State private var appeared = false
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        ZStack {
            Theme.gradient.ignoresSafeArea()
            Circle().fill(.white.opacity(0.08)).frame(width: 420).offset(x: 160, y: -300)
                .blur(radius: 2)
            Circle().fill(.white.opacity(0.06)).frame(width: 300).offset(x: -170, y: 260)

            VStack(spacing: 0) {
                Spacer()
                Image(systemName: "pills.fill")
                    .font(.system(size: 54, weight: .medium))
                    .foregroundStyle(.white)
                    .padding(26)
                    .background(.white.opacity(0.18), in: RoundedRectangle(cornerRadius: 30, style: .continuous))
                    .scaleEffect(appeared ? 1 : 0.6)
                    .opacity(appeared ? 1 : 0)
                Text(state.t("app.name"))
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.top, 22)
                Text(state.t("signin.title"))
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.95))
                    .multilineTextAlignment(.center)
                    .padding(.top, 10)
                Text(state.t("signin.subtitle"))
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.8))
                    .multilineTextAlignment(.center)
                    .padding(.top, 10)
                    .padding(.horizontal, 12)
                Spacer()

                VStack(spacing: 14) {
                    if pending != nil {
                        HStack(spacing: 12) {
                            ProgressView().tint(.white)
                            Text(state.t("signin.waiting"))
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.white)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity)
                        .background(.white.opacity(0.16), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .transition(.move(edge: .bottom).combined(with: .opacity))

                        Button(state.t("signin.openAgain")) { openBot() }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        Button(state.t("signin.cancel")) { cancel() }
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.75))
                    } else {
                        Button {
                            Task { await begin() }
                        } label: {
                            HStack(spacing: 10) {
                                if busy {
                                    ProgressView().tint(Theme.accent)
                                } else {
                                    Image(systemName: "paperplane.fill")
                                }
                                Text(state.t("signin.button")).font(.headline)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 17)
                            .foregroundStyle(Theme.accent)
                            .background(.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .shadow(color: .black.opacity(0.15), radius: 18, y: 8)
                        }
                        .buttonStyle(PressableStyle())
                        .disabled(busy)

                        Picker("", selection: Binding(get: { state.lang }, set: { state.setLangLocally($0) })) {
                            ForEach(Lang.allCases) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .frame(width: 240)
                        .padding(.top, 6)

                        Button {
                            Task { await state.enterDemo() }
                        } label: {
                            Label(state.t("signin.demo"), systemImage: "sparkles")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 18)
                                .padding(.vertical, 10)
                                .background(.white.opacity(0.16), in: Capsule())
                        }
                        .buttonStyle(PressableStyle())
                        .padding(.top, 4)
                    }
                }
                .animation(.spring(response: 0.45, dampingFraction: 0.85), value: pending != nil)
                .padding(.bottom, 24)
            }
            .padding(.horizontal, 28)
        }
        .onAppear {
            withAnimation(.spring(response: 0.7, dampingFraction: 0.7).delay(0.1)) { appeared = true }
        }
        .onChange(of: scenePhase) { _, phase in
            // Back from Telegram: ask at once instead of waiting for the next tick.
            if phase == .active, pending != nil { startPolling() }
        }
        .onDisappear { pollTask?.cancel() }
    }

    private func begin() async {
        busy = true
        defer { busy = false }
        do {
            let started = try await state.api.startSignIn()
            pending = started
            openBot()
            startPolling()
        } catch {
            state.fail(error)
        }
    }

    private func openBot() {
        guard let pending, let url = URL(string: pending.botUrl) else { return }
        UIApplication.shared.open(url) { opened in
            if !opened { state.show(state.t("signin.noTelegram"), error: true) }
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        guard let token = pending?.pollToken else { return }
        pollTask = Task {
            while !Task.isCancelled {
                do {
                    if let access = try await state.api.pollSignIn(token) {
                        pending = nil
                        await state.signedIn(token: access)
                        return
                    }
                } catch APIError.conflict {
                    pending = nil
                    state.show(state.t("signin.expired"), error: true)
                    return
                } catch {
                    // Network blips: keep trying until the sign-in expires.
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func cancel() {
        pollTask?.cancel()
        withAnimation { pending = nil }
    }
}
