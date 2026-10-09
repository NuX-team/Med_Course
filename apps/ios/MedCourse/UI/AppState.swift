import SwiftUI

/// Everything the screens share: who is signed in, their language, the API, and a toast.
@MainActor
final class AppState: ObservableObject {
    enum Phase: Equatable { case loading, signedOut, signedIn }

    @Published var phase: Phase = .loading
    @Published var me: Me?
    @Published var lang: Lang = .ru
    @Published var toast: Toast?
    @Published var restricted = false

    let api = APIClient()
    var t: Strings { Strings(lang: lang) }
    var format: Formatting { Formatting(lang: lang) }

    init() {
        if let stored = UserDefaults.standard.string(forKey: "lang"), let lang = Lang(rawValue: stored) {
            self.lang = lang
        }
    }

    func boot() async {
        guard api.token != nil else {
            phase = .signedOut
            return
        }
        await refreshMe()
    }

    func refreshMe() async {
        do {
            let me = try await api.me()
            apply(me)
            phase = .signedIn
        } catch APIError.unauthorized {
            signOutLocally()
        } catch {
            // Offline at launch: stay signed in, screens show their own retry.
            phase = .signedIn
        }
    }

    func apply(_ me: Me) {
        self.me = me
        restricted = me.consent == "REVOKED" || me.deletionDueAt != nil
        if let lang = Lang(rawValue: me.locale) { setLangLocally(lang) }
    }

    func signedIn(token: String) async {
        TokenStore.save(token)
        api.token = token
        await refreshMe()
        Haptics.success()
    }

    func signOut() async {
        await api.logout()
        signOutLocally()
    }

    func signOutLocally() {
        TokenStore.clear()
        api.token = nil
        me = nil
        withAnimation(.easeInOut) { phase = .signedOut }
    }

    func setLangLocally(_ lang: Lang) {
        self.lang = lang
        UserDefaults.standard.set(lang.rawValue, forKey: "lang")
    }

    func changeLanguage(_ lang: Lang) async {
        setLangLocally(lang)
        if let me = try? await api.setLocale(lang.rawValue) { apply(me) }
    }

    func show(_ text: String, error: Bool = false) {
        withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) { toast = Toast(text: text, isError: error) }
        let shown = toast
        Task {
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            if toast == shown { withAnimation(.easeOut) { toast = nil } }
        }
    }

    /// Turns an API error into a sentence; signs out on 401, flips to the privacy screen on 403.
    func fail(_ error: Error) {
        guard let error = error as? APIError else {
            show(t("error.generic"), error: true)
            return
        }
        switch error {
        case .unauthorized:
            signOutLocally()
        case .privacyRestricted:
            restricted = true
        case .network:
            show(t("error.network"), error: true)
        default:
            let key = "error.\(error.code)"
            let text = t(key)
            show(text == key ? t("error.generic") : text, error: true)
        }
    }

    func openBot() {
        let username = (Bundle.main.object(forInfoDictionaryKey: "MCBotUsername") as? String) ?? ""
        if let url = URL(string: "tg://resolve?domain=\(username)"), UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url)
        } else if let url = URL(string: "https://t.me/\(username)") {
            UIApplication.shared.open(url)
        }
    }
}
