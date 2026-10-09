import SwiftUI

@main
struct MedCourseApp: App {
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var push
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .tint(Theme.accent)
                .task {
                    PushDelegate.state = state
                    await state.boot()
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ZStack(alignment: .top) {
            Group {
                switch state.phase {
                case .loading:
                    SplashView()
                case .signedOut:
                    SignInView().transition(.opacity.combined(with: .scale(scale: 0.98)))
                case .signedIn:
                    if state.restricted {
                        NavigationStack { PrivacyView() }
                    } else {
                        MainTabs().transition(.opacity)
                    }
                }
            }
            .animation(.easeInOut(duration: 0.35), value: state.phase)

            if let toast = state.toast {
                ToastView(toast: toast)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .padding(.top, 8)
                    .zIndex(1)
            }
        }
    }
}

struct SplashView: View {
    @State private var pulse = false

    var body: some View {
        ZStack {
            Theme.gradient.ignoresSafeArea()
            Image(systemName: "pills.fill")
                .font(.system(size: 64, weight: .medium))
                .foregroundStyle(.white)
                .scaleEffect(pulse ? 1.06 : 0.94)
                .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulse)
        }
        .onAppear { pulse = true }
    }
}

struct MainTabs: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        TabView {
            NavigationStack { TodayView() }
                .tabItem { Label(state.t("tab.today"), systemImage: "sun.max.fill") }
            NavigationStack { CoursesView() }
                .tabItem { Label(state.t("tab.courses"), systemImage: "cross.case.fill") }
            NavigationStack { SettingsView() }
                .tabItem { Label(state.t("tab.settings"), systemImage: "person.crop.circle.fill") }
        }
    }
}

/// Push tokens are sent to the server for later; reminders today come through Telegram.
final class PushDelegate: NSObject, UIApplicationDelegate {
    @MainActor static weak var state: AppState?

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in await PushDelegate.state?.api.registerDevice(token) }
    }
}
