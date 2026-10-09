import SwiftUI

/// One accent, soft surfaces, generous radii: a calm, Apple-like look.
enum Theme {
    static let accent = Color(red: 0.16, green: 0.47, blue: 0.96)
    static let accentSoft = Color(red: 0.16, green: 0.47, blue: 0.96).opacity(0.12)
    static let success = Color(red: 0.13, green: 0.70, blue: 0.45)
    static let warning = Color(red: 0.98, green: 0.62, blue: 0.10)
    static let danger = Color(red: 0.93, green: 0.28, blue: 0.30)
    static let card = Color(.secondarySystemGroupedBackground)
    static let background = Color(.systemGroupedBackground)
    static let radius: CGFloat = 22

    static let gradient = LinearGradient(
        colors: [Color(red: 0.18, green: 0.52, blue: 1.0), Color(red: 0.45, green: 0.36, blue: 0.98)],
        startPoint: .topLeading, endPoint: .bottomTrailing)

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "TAKEN": return success
        case "TAKEN_LATE": return warning
        case "SKIPPED", "MISSED": return danger
        case "NOTIFIED": return accent
        case "SNOOZED": return warning
        default: return .secondary
        }
    }

    static func statusIcon(_ status: String) -> String {
        switch status {
        case "TAKEN": return "checkmark.circle.fill"
        case "TAKEN_LATE": return "clock.badge.checkmark.fill"
        case "SKIPPED": return "xmark.circle.fill"
        case "MISSED": return "exclamationmark.circle.fill"
        case "SNOOZED": return "alarm.fill"
        case "NOTIFIED": return "bell.badge.fill"
        default: return "circle"
        }
    }

    static func courseColor(_ status: String) -> Color {
        switch status {
        case "ACTIVE": return success
        case "PENDING_PATIENT": return accent
        case "PAUSED": return warning
        default: return .secondary
        }
    }
}

struct CardStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(18)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .shadow(color: .black.opacity(0.04), radius: 12, y: 4)
    }
}

extension View {
    func card() -> some View { modifier(CardStyle()) }
}

/// Soft press: scales down a touch and back, with a light haptic.
struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

struct PrimaryButton: View {
    let title: String
    var icon: String? = nil
    var color: Color = Theme.accent
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy {
                    ProgressView().tint(.white)
                } else if let icon {
                    Image(systemName: icon).font(.body.weight(.semibold))
                }
                Text(title).font(.body.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .foregroundStyle(.white)
            .background(color, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(PressableStyle())
        .disabled(busy)
    }
}

struct SecondaryButton: View {
    let title: String
    var icon: String? = nil
    var color: Color = Theme.accent
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Image(systemName: icon) }
                Text(title)
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressableStyle())
    }
}

struct StatusPill: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: Capsule())
    }
}

struct ProgressRing: View {
    let fraction: Double
    var lineWidth: CGFloat = 10
    var color: Color = Theme.accent

    var body: some View {
        ZStack {
            Circle().stroke(color.opacity(0.15), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: max(0.001, fraction))
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.spring(response: 0.8, dampingFraction: 0.8), value: fraction)
        }
    }
}

struct EmptyState: View {
    let icon: String
    let title: String
    let text: String

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Theme.gradient)
                .padding(22)
                .background(Theme.accentSoft, in: Circle())
            Text(title).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
            Text(text).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity)
    }
}

/// A short message sliding in from the top and leaving by itself.
struct Toast: Equatable {
    let text: String
    var isError = false
}

struct ToastView: View {
    let toast: Toast

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: toast.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(toast.isError ? Theme.danger : Theme.success)
            Text(toast.text).font(.subheadline.weight(.medium))
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.regularMaterial, in: Capsule())
        .shadow(color: .black.opacity(0.12), radius: 16, y: 6)
        .padding(.horizontal, 20)
    }
}

enum Haptics {
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
    static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}
