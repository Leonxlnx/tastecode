import SwiftUI
import UIKit

/// The typeface for the app's text. Code keeps its monospaced font.
enum FontChoice: String, CaseIterable, Identifiable {
  case standard, rounded, serif, monospaced

  var id: Self { self }

  var title: String {
    switch self {
    case .standard: return "Default"
    case .rounded: return "Rounded"
    case .serif: return "Serif"
    case .monospaced: return "Mono"
    }
  }

  var design: Font.Design {
    switch self {
    case .standard: return .default
    case .rounded: return .rounded
    case .serif: return .serif
    case .monospaced: return .monospaced
    }
  }
}

enum AppearanceKey {
  static let followSystemSize = "appearance.followSystemSize"
  static let sizeStep = "appearance.sizeStep"
  static let font = "appearance.font"
  static let bold = "appearance.bold"
}

/// The text sizes the slider steps through, smallest first; `large` is the iPhone's default.
let textSizeSteps: [DynamicTypeSize] = [.xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge]
private let defaultSizeStep = 3

/// Applies the chosen text size, typeface and weight to everything below it.
/// One unbranched chain: a branch would make a change rebuild the screens and close any open sheet.
struct AppearanceModifier: ViewModifier {
  @AppStorage(AppearanceKey.followSystemSize) private var followSystem = true
  @AppStorage(AppearanceKey.sizeStep) private var step = defaultSizeStep
  @AppStorage(AppearanceKey.font) private var font = FontChoice.standard
  @AppStorage(AppearanceKey.bold) private var bold = false
  @Environment(\.dynamicTypeSize) private var systemSize

  func body(content: Content) -> some View {
    content
      .fontDesign(font.design)
      .environment(\.legibilityWeight, bold ? .bold : nil)
      .dynamicTypeSize(followSystem ? systemSize : textSizeSteps[clamped(step)])
  }
}

private func clamped(_ step: Int) -> Int {
  min(max(step, 0), textSizeSteps.count - 1)
}

/// The appearance chosen in Settings, read from where its page keeps it, for UIKit.
struct AppearanceChoice {
  /// Nil while the app follows the iPhone's text size.
  let contentSize: UIContentSizeCategory?
  let bold: Bool
  let font: FontChoice

  static var current: AppearanceChoice {
    let defaults = UserDefaults.standard
    let follow = defaults.object(forKey: AppearanceKey.followSystemSize) as? Bool ?? true
    let step = defaults.object(forKey: AppearanceKey.sizeStep) as? Int ?? defaultSizeStep
    return AppearanceChoice(
      contentSize: follow ? nil : UIContentSizeCategory(textSizeSteps[clamped(step)]),
      bold: defaults.bool(forKey: AppearanceKey.bold),
      font: FontChoice(rawValue: defaults.string(forKey: AppearanceKey.font) ?? "") ?? .standard)
  }
}

/// The typeface chosen in Settings, carried down the view tree like the text size.
struct FontDesignTrait: UITraitDefinition {
  static let defaultValue = FontChoice.standard
  static let name = "TasteFontDesign"
}

extension UIFont {
  /// A text style in the chosen typeface, at the size the traits ask for,
  /// a step heavier when Bold Text is on, as SwiftUI draws it.
  static func app(
    _ style: TextStyle, weight: Weight? = nil, traits: UITraitCollection
  ) -> UIFont {
    let base = UIFont.preferredFont(forTextStyle: style, compatibleWith: traits)
    var descriptor = base.fontDescriptor
    if var weight {
      if traits.legibilityWeight == .bold { weight = weight.bolder }
      descriptor = descriptor.addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: weight]])
    }
    if let design = traits[FontDesignTrait.self].systemDesign, let designed = descriptor.withDesign(design) {
      descriptor = designed
    }
    return UIFont(descriptor: descriptor, size: base.pointSize)
  }
}

extension UIFont.Weight {
  /// The next weight up, as Bold Text turns regular into semibold.
  var bolder: UIFont.Weight {
    switch self {
    case .ultraLight: return .light
    case .thin, .light: return .regular
    case .regular: return .semibold
    case .medium, .semibold: return .bold
    default: return .heavy
    }
  }
}

extension FontChoice {
  var systemDesign: UIFontDescriptor.SystemDesign? {
    switch self {
    case .standard: return nil
    case .rounded: return .rounded
    case .serif: return .serif
    case .monospaced: return .monospaced
    }
  }
}

extension UIContentSizeCategory {
  init(_ size: DynamicTypeSize) {
    switch size {
    case .xSmall: self = .extraSmall
    case .small: self = .small
    case .medium: self = .medium
    case .large: self = .large
    case .xLarge: self = .extraLarge
    case .xxLarge: self = .extraExtraLarge
    default: self = .extraExtraExtraLarge
    }
  }
}

/// Settings › Appearance: a live sample of a chat, then text size, typeface and weight.
struct AppearanceSettings: View {
  @AppStorage(AppearanceKey.followSystemSize) private var followSystem = true
  @AppStorage(AppearanceKey.sizeStep) private var step = defaultSizeStep
  @AppStorage(AppearanceKey.font) private var font = FontChoice.standard
  @AppStorage(AppearanceKey.bold) private var bold = false
  @Environment(\.dynamicTypeSize) private var systemSize

  var body: some View {
    Form {
      Section {
        ChatSample(systemSize: systemSize)
          .listRowInsets(EdgeInsets(top: 18, leading: 16, bottom: 18, trailing: 16))
      }
      Section {
        Toggle("Same as iPhone", isOn: $followSystem.animation(.smooth))
          .tint(.green)
          .onChange(of: followSystem) { _, follows in
            // Turning it off starts the slider where the iPhone's setting is.
            if !follows { step = textSizeSteps.firstIndex(of: systemSize) ?? defaultSizeStep }
          }
        if !followSystem {
          SizeSlider(step: $step)
        }
      } header: {
        Text("Text Size")
      } footer: {
        Text(followSystem ? "Follows Settings › Display & Brightness › Text Size." : "Only TasteCode uses this size.")
      }
      Section("Font") {
        FontRow(font: $font)
          .listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12))
        Toggle("Bold Text", isOn: $bold)
          .tint(.green)
      }
    }
    // The page keeps its own size steady, so the slider does not move under the finger.
    .dynamicTypeSize(.large)
    .navigationTitle("Appearance")
    .navigationBarTitleDisplayMode(.inline)
  }
}

/// A user message and a reply, drawn with the settings being chosen.
private struct ChatSample: View {
  @AppStorage(AppearanceKey.followSystemSize) private var followSystem = true
  @AppStorage(AppearanceKey.sizeStep) private var step = defaultSizeStep
  @AppStorage(AppearanceKey.font) private var font = FontChoice.standard
  @AppStorage(AppearanceKey.bold) private var bold = false
  /// The iPhone's own size, read outside the page's steady one.
  let systemSize: DynamicTypeSize

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Why does the date test fail at midnight?")
        .font(.body)
        .padding(.horizontal, 13)
        .padding(.vertical, 8)
        .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 18, style: .continuous))
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 40)
      Text("It reads the date in the local time zone. \(Text("parseDate").font(.system(.subheadline, design: .monospaced))) should use UTC, then the test passes.")
        .font(.body)
        .lineSpacing(2)
    }
    .fontDesign(font.design)
    .environment(\.legibilityWeight, bold ? .bold : nil)
    .dynamicTypeSize(followSystem ? systemSize : textSizeSteps[clamped(step)])
    .animation(.smooth(duration: 0.25), value: step)
    .animation(.smooth(duration: 0.25), value: font)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// The system's text size control: a small A, a stepped track, a large A.
private struct SizeSlider: View {
  @Binding var step: Int

  var body: some View {
    HStack(spacing: 14) {
      Image(tabler: "text-decrease", size: 15)
        .foregroundStyle(.secondary)
      Slider(
        value: Binding(get: { Double(clamped(step)) }, set: { step = Int($0.rounded()) }),
        in: 0...Double(textSizeSteps.count - 1),
        step: 1
      )
      .tint(.primary)
      .sensoryFeedback(.selection, trigger: step)
      Image(tabler: "text-increase", size: 24)
        .foregroundStyle(.secondary)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Text size")
  }
}

/// The four typefaces side by side, each shown in itself.
private struct FontRow: View {
  @Binding var font: FontChoice

  var body: some View {
    HStack(spacing: 8) {
      ForEach(FontChoice.allCases) { choice in
        let selected = font == choice
        Button {
          withAnimation(.smooth(duration: 0.2)) { font = choice }
        } label: {
          VStack(spacing: 6) {
            Text("Aa")
              .font(.system(size: 26, weight: .regular, design: choice.design))
              .foregroundStyle(.primary)
            Text(choice.title)
              .font(.caption)
              .foregroundStyle(selected ? .primary : .secondary)
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 12)
          .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(selected ? Color(.tertiarySystemFill) : .clear)
          }
          .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .strokeBorder(Color.primary.opacity(selected ? 0.5 : 0), lineWidth: 1.5)
          }
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(choice.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
    }
    .sensoryFeedback(.selection, trigger: font)
  }
}
