import SwiftUI
import UIKit

enum HarnessColor {
  static let background = Color(uiColor: .systemBackground)
  static let control = Color.white.opacity(0.11)
  static let separator = Color.white.opacity(0.08)
  static let outline = Color.white.opacity(0.085)
  static let primary = Color.white.opacity(0.92)
  static let secondary = Color.white.opacity(0.58)
  static let tertiary = Color.white.opacity(0.34)
  static let blue = Color(red: 0.05, green: 0.50, blue: 1.0)
  static let green = Color(red: 0.20, green: 0.84, blue: 0.62)
  static let red = Color(red: 1.0, green: 0.31, blue: 0.37)
}

enum HarnessMetrics {
  static let pageInset: CGFloat = 14
  static let surfaceRadius: CGFloat = 16
  static let compactControlHeight: CGFloat = 32
  static let rowHeight: CGFloat = 50
}

enum HarnessIconMetrics {
  static let visualScale: CGFloat = 1

  static func renderedSize(_ nominalSize: CGFloat) -> CGFloat {
    nominalSize * visualScale
  }
}

struct GlassIconButton: View {
  let icon: LucideIcon
  let accessibilityLabel: String
  var size: CGFloat = 40
  var iconSize: CGFloat?
  var prominent = false
  var disabled = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      GlassIconLabel(
        icon: icon,
        size: size,
        iconSize: iconSize,
        prominent: prominent
      )
      .frame(width: max(size, 44), height: max(size, 44))
      .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.4 : 1)
    .accessibilityLabel(accessibilityLabel)
  }
}

struct GlassIconLabel: View {
  let icon: LucideIcon
  var size: CGFloat = 40
  var iconSize: CGFloat?
  var prominent = false

  var body: some View {
    LucideIconView(icon, size: iconSize ?? size * 0.38)
      .foregroundStyle(.primary)
      .frame(width: size, height: size)
      .glassEffect(glass, in: .circle)
  }

  private var glass: Glass {
    if prominent {
      return .regular.tint(HarnessColor.blue).interactive()
    }
    return .regular.interactive()
  }
}

struct HarnessIconBadge: View {
  let icon: LucideIcon
  var tint: Color = HarnessColor.secondary
  var size: CGFloat = 32
  var iconSize: CGFloat?

  var body: some View {
    LucideIconView(icon, size: iconSize ?? size * 0.44)
      .foregroundStyle(tint)
      .frame(width: size, height: size)
      .background(tint.opacity(0.15), in: .circle)
      .accessibilityHidden(true)
  }
}

struct HarnessPillLabel: View {
  let title: String
  var foregroundStyle: Color = HarnessColor.primary

  var body: some View {
    Text(title)
      .font(.system(size: 12, weight: .semibold))
      .foregroundStyle(foregroundStyle)
      .padding(.horizontal, 12)
      .frame(height: HarnessMetrics.compactControlHeight)
      .background(HarnessColor.control, in: .capsule)
  }
}

struct LucideLabel: View {
  let title: String
  let icon: LucideIcon
  var iconSize: CGFloat = 16
  var iconColor: Color?

  nonisolated init(
    _ title: String,
    icon: LucideIcon,
    iconSize: CGFloat = 16,
    iconColor: Color? = nil
  ) {
    self.title = title
    self.icon = icon
    self.iconSize = iconSize
    self.iconColor = iconColor
  }

  var body: some View {
    Label {
      Text(title)
    } icon: {
      Group {
        if let iconColor {
          LucideIconView(icon, size: iconSize)
            .foregroundStyle(iconColor)
        } else {
          LucideIconView(icon, size: iconSize)
        }
      }
      .frame(width: 18, height: 18, alignment: .center)
    }
    .labelStyle(.titleAndIcon)
  }
}

struct LucideActionLabel: View {
  let title: String
  let icon: LucideIcon

  var body: some View {
    Label(title, image: icon.assetName)
  }
}

struct GlassCapsuleLabel: View {
  let icon: LucideIcon?
  let title: String
  var subtitle: String?

  var body: some View {
    HStack(spacing: 7) {
      if let icon {
        LucideIconView(icon, size: 13)
      }
      VStack(alignment: .leading, spacing: 0) {
        Text(title)
          .font(.system(size: 15, weight: .semibold))
          .lineLimit(1)
        if let subtitle {
          Text(subtitle)
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      LucideIconView(.chevronDown, size: 9)
        .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 12)
    .frame(height: 36)
    .harnessGlassCapsule()
  }
}

struct ProviderGlyph: View {
  let provider: ProviderID
  var size: CGFloat = 19

  var body: some View {
    Image(assetName)
      .resizable()
      .renderingMode(.template)
      .scaledToFit()
      .frame(
        width: HarnessIconMetrics.renderedSize(size),
        height: HarnessIconMetrics.renderedSize(size)
      )
      .accessibilityHidden(true)
      .frame(width: size + 2, height: size + 2)
  }

  private var assetName: String {
    switch provider {
    case .codex: "OpenAIBlossom"
    case .claudeCode: "ProviderAnthropic"
    case .grok: "ProviderGrok"
    case .cursor: "ProviderCursor"
    case .opencode: "ProviderOpencode"
    case .antigravity: "ProviderAntigravity"
    case .acp: "ProviderAcp"
    case .api: "ProviderCustom"
    }
  }
}

struct AgentGlyph: View {
  let agentID: String?
  var size: CGFloat = 19

  var body: some View {
    Group {
      if agentID?.lowercased() == "kimi" {
        ZStack {
          Image("ProviderKimiAccent")
            .resizable()
            .scaledToFit()
          Image("ProviderKimi")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
        }
      } else {
        Image(assetName)
          .resizable()
          .renderingMode(.template)
          .scaledToFit()
      }
    }
    .frame(
      width: HarnessIconMetrics.renderedSize(size),
      height: HarnessIconMetrics.renderedSize(size)
    )
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }

  private var assetName: String {
    switch agentID?.lowercased() {
    case "gemini": "ProviderGemini"
    case "qwen": "ProviderQwen"
    default: "ProviderAcp"
    }
  }
}

struct LucideLoader: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var size: CGFloat = 16
  @State private var rotating = false

  var body: some View {
    LucideIconView(.loader, size: size)
      .rotationEffect(.degrees(rotating ? 360 : 0))
      .animation(
        reduceMotion ? nil : .linear(duration: 0.9).repeatForever(autoreverses: false),
        value: rotating
      )
      .onAppear { rotating = !reduceMotion }
      .onChange(of: reduceMotion) { _, value in rotating = !value }
  }
}

struct SheetHeader: View {
  let title: String
  var leading: AnyView?
  var trailing: AnyView?

  var body: some View {
    ZStack {
      Text(title)
        .font(.system(size: 15, weight: .semibold))
      HStack {
        leading
        Spacer()
        trailing
      }
    }
    .frame(height: 50)
    .padding(.horizontal, HarnessMetrics.pageInset)
    .padding(.top, 4)
  }
}

struct SettingsSection<Content: View>: View {
  let title: String
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(HarnessColor.secondary)
        .padding(.leading, 6)
      VStack(spacing: 0) { content }
        .harnessSurface()
    }
  }
}

struct SettingsRow<Trailing: View>: View {
  let icon: LucideIcon
  let title: String
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack(spacing: 11) {
      LucideIconView(icon, size: 14)
        .frame(width: 18)
      Text(title)
        .font(.system(size: 14))
      Spacer(minLength: 9)
      trailing
    }
    .padding(.horizontal, 14)
    .frame(minHeight: 44)
    .contentShape(.rect)
  }
}

extension View {
  func harnessSurface(
    cornerRadius: CGFloat = HarnessMetrics.surfaceRadius,
    fill: Color = .clear,
    outline: Color = HarnessColor.outline,
    interactive: Bool = false
  ) -> some View {
    modifier(
      HarnessSurfaceModifier(
        fill: fill,
        outline: outline,
        cornerRadius: cornerRadius,
        interactive: interactive
      )
    )
  }

  func harnessGlassCapsule(minimumHitHeight: CGFloat = 44) -> some View {
    glassEffect(.regular.interactive(), in: .capsule)
      .frame(minHeight: minimumHitHeight)
      .contentShape(.capsule)
  }

  func harnessSheetBackground() -> some View {
    presentationBackground(.ultraThinMaterial)
      .presentationCornerRadius(32)
      .presentationDragIndicator(.visible)
      .preferredColorScheme(.dark)
  }
}

private struct HarnessSurfaceModifier: ViewModifier {
  let fill: Color
  let outline: Color
  let cornerRadius: CGFloat
  let interactive: Bool

  func body(content: Content) -> some View {
    content
      .background(
        fill,
        in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
      )
      .glassEffect(glass, in: .rect(cornerRadius: cornerRadius))
      .overlay {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(outline, lineWidth: 1)
          .allowsHitTesting(false)
      }
  }

  private var glass: Glass {
    interactive ? .regular.interactive() : .regular
  }
}
