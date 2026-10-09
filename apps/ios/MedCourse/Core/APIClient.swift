import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Security)
import Security
#endif

enum APIError: Error, Equatable {
    case unauthorized
    case privacyRestricted
    case notFound
    case conflict(String)
    case server(Int, String)
    case network
    case decoding

    var code: String {
        switch self {
        case .unauthorized: return "unauthorized"
        case .privacyRestricted: return "privacy_restricted"
        case .notFound: return "not_found"
        case .conflict(let code): return code
        case .server(_, let code): return code
        case .network: return "network"
        case .decoding: return "decoding"
        }
    }
}

/// The address of the API: the `MCAPIBaseURL` key of Info.plist (build setting API_BASE_URL).
enum AppConfig {
    static var baseURL: URL {
        let raw = Bundle.main.object(forInfoDictionaryKey: "MCAPIBaseURL") as? String
        return URL(string: (raw?.isEmpty == false ? raw! : "http://localhost:3003"))!
    }
}

/// The bearer token lives in the Keychain, never in UserDefaults.
enum TokenStore {
    private static let service = "uz.medcourse.app"
    private static let account = "access-token"

    static func load() -> String? {
        #if canImport(Security)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
        #else
        return nil
        #endif
    }

    static func save(_ token: String) {
        #if canImport(Security)
        clear()
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(token.utf8),
        ]
        SecItemAdd(attributes as CFDictionary, nil)
        #endif
    }

    static func clear() {
        #if canImport(Security)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        #endif
    }
}

/// One small client for docs/MOBILE_API.md. Every answer to a dose carries a fresh
/// Idempotency-Key: a retried request is recorded once on the server.
final class APIClient: @unchecked Sendable {
    let baseURL: URL
    var token: String?
    private let session: URLSession

    init(baseURL: URL = AppConfig.baseURL, token: String? = TokenStore.load()) {
        self.baseURL = baseURL
        self.token = token
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        self.session = URLSession(configuration: configuration)
    }

    // MARK: Sign-in

    func startSignIn() async throws -> SignInStart {
        try await send("POST", "/v1/auth/start", body: [String: String]())
    }

    /// nil while the person has not confirmed in the bot yet.
    func pollSignIn(_ pollToken: String) async throws -> String? {
        let result: SignInPoll = try await send(
            "POST", "/v1/auth/poll", body: ["pollToken": pollToken, "platform": "ios"])
        return result.status == "ready" ? result.accessToken : nil
    }

    func logout() async {
        let _: OK? = try? await send("POST", "/v1/auth/logout", body: [String: String]())
    }

    // MARK: Reading

    func me() async throws -> Me { try await send("GET", "/v1/me") }
    func today() async throws -> TodayResponse { try await send("GET", "/v1/today") }
    func courses() async throws -> [Course] {
        let response: CoursesResponse = try await send("GET", "/v1/courses")
        return response.courses
    }
    func course(_ id: String) async throws -> CourseDetail { try await send("GET", "/v1/courses/\(id)") }
    func startPreview(_ id: String) async throws -> StartPreview {
        try await send("GET", "/v1/courses/\(id)/start")
    }
    func change(_ id: String) async throws -> ChangeInfo? {
        let response: ChangeResponse = try await send("GET", "/v1/courses/\(id)/change")
        return response.change
    }
    func days(_ id: String, page: Int) async throws -> DaysResponse {
        try await send("GET", "/v1/courses/\(id)/days?page=\(page)")
    }
    func privacy() async throws -> PrivacyResponse { try await send("GET", "/v1/privacy") }

    // MARK: Acting

    func start(_ id: String) async throws -> StartResult {
        try await send("POST", "/v1/courses/\(id)/start", body: [String: String]())
    }
    func acceptChange(_ id: String) async throws {
        let _: OKCourse = try await send(
            "POST", "/v1/courses/\(id)/change/accept", body: [String: String](), idempotent: true)
    }
    func requestPause(_ id: String) async throws -> String {
        let response: StatusOnly = try await send(
            "POST", "/v1/courses/\(id)/pause-request", body: [String: String]())
        return response.status
    }
    func take(_ doseId: String) async throws -> Dose {
        let response: AnswerResponse = try await send(
            "POST", "/v1/doses/\(doseId)/take", body: [String: String](), idempotent: true)
        return response.dose
    }
    func skip(_ doseId: String, reason: String, note: String?) async throws -> Dose {
        var body = ["reason": reason]
        if let note, !note.isEmpty { body["note"] = note }
        let response: AnswerResponse = try await send(
            "POST", "/v1/doses/\(doseId)/skip", body: body, idempotent: true)
        return response.dose
    }
    func snooze(_ doseId: String, minutes: Int) async throws -> Dose {
        let response: AnswerResponse = try await send(
            "POST", "/v1/doses/\(doseId)/snooze", body: ["minutes": minutes], idempotent: true)
        return response.dose
    }
    func undo(_ doseId: String) async throws -> Dose {
        let response: AnswerResponse = try await send(
            "POST", "/v1/doses/\(doseId)/undo", body: [String: String](), idempotent: true)
        return response.dose
    }
    func takePrn(_ medicationId: String) async throws -> Bool {
        let response: PrnTaken = try await send(
            "POST", "/v1/prn/\(medicationId)/take", body: [String: String](), idempotent: true)
        return response.overLimit
    }
    func undoPrn(_ eventId: String) async throws {
        let _: OKPrn = try await send(
            "POST", "/v1/prn/events/\(eventId)/undo", body: [String: String]())
    }
    func setLocale(_ locale: String) async throws -> Me {
        try await send("PATCH", "/v1/me", body: ["locale": locale])
    }
    func registerDevice(_ token: String) async {
        let _: OK? = try? await send("POST", "/v1/me/device", body: ["platform": "ios", "token": token])
    }
    func withdrawConsent() async throws {
        let _: OK = try await send("POST", "/v1/privacy/withdraw", body: [String: String](), idempotent: true)
    }
    func requestDeletion() async throws {
        let _: OK = try await send(
            "POST", "/v1/privacy/delete-request", body: [String: String](), idempotent: true)
    }
    func cancelDeletion() async throws {
        let _: OK = try await send("POST", "/v1/privacy/delete-cancel", body: [String: String]())
    }

    // MARK: Transport

    private struct OK: Decodable {}
    private struct OKCourse: Decodable {}
    private struct OKPrn: Decodable {}
    private struct StatusOnly: Decodable { let status: String }
    private struct PrnTaken: Decodable { let overLimit: Bool }

    private func send<Response: Decodable>(
        _ method: String, _ path: String, idempotent: Bool = false
    ) async throws -> Response {
        try await perform(method, path, body: nil, idempotent: idempotent)
    }

    private func send<Response: Decodable, Body: Encodable>(
        _ method: String, _ path: String, body: Body, idempotent: Bool = false
    ) async throws -> Response {
        try await perform(method, path, body: try JSONEncoder().encode(body), idempotent: idempotent)
    }

    private func perform<Response: Decodable>(
        _ method: String, _ path: String, body: Data?, idempotent: Bool
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: baseURL) else { throw APIError.notFound }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if idempotent { request.setValue(UUID().uuidString, forHTTPHeaderField: "idempotency-key") }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) {
            do {
                return try JSON.decoder.decode(Response.self, from: data)
            } catch {
                throw APIError.decoding
            }
        }
        let code = (try? JSON.decoder.decode(APIErrorBody.self, from: data))?.error ?? "unknown"
        switch status {
        case 401: throw APIError.unauthorized
        case 403 where code == "privacy_restricted": throw APIError.privacyRestricted
        case 404: throw APIError.notFound
        case 409, 410: throw APIError.conflict(code)
        default: throw APIError.server(status, code)
        }
    }
}
