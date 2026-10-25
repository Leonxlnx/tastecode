import SwiftUI

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
      Image(systemName: "textformat.size.smaller")
        .font(.footnote)
        .foregroundStyle(.secondary)
      Slider(
        value: Binding(get: { Double(clamped(step)) }, set: { step = Int($0.rounded()) }),
        in: 0...Double(textSizeSteps.count - 1),
        step: 1
      )
      .tint(.primary)
      .sensoryFeedback(.selection, trigger: step)
      Image(systemName: "textformat.size.larger")
        .font(.title3)
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
