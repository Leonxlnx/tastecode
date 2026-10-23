import SwiftUI

/// How large the app's text is: the system's choice, or one picked here.
enum TextSizeChoice: String, CaseIterable, Identifiable {
  case system, small, medium, large, extraLarge

  var id: Self { self }

  var title: String {
    switch self {
    case .system: return "Same as iPhone"
    case .small: return "Small"
    case .medium: return "Medium"
    case .large: return "Large"
    case .extraLarge: return "Extra Large"
    }
  }

  var size: DynamicTypeSize? {
    switch self {
    case .system: return nil
    case .small: return .medium
    case .medium: return .large
    case .large: return .xLarge
    case .extraLarge: return .xxLarge
    }
  }
}

/// The typeface for the app's text. Code keeps its monospaced font.
enum FontChoice: String, CaseIterable, Identifiable {
  case standard, rounded, serif, monospaced

  var id: Self { self }

  var title: String {
    switch self {
    case .standard: return "Default"
    case .rounded: return "Rounded"
    case .serif: return "Serif"
    case .monospaced: return "Monospaced"
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
  static let textSize = "appearance.textSize"
  static let font = "appearance.font"
}

/// Applies the chosen text size and typeface to everything below it.
struct AppearanceModifier: ViewModifier {
  @AppStorage(AppearanceKey.textSize) private var textSize = TextSizeChoice.system
  @AppStorage(AppearanceKey.font) private var font = FontChoice.standard

  func body(content: Content) -> some View {
    if let size = textSize.size {
      content.dynamicTypeSize(size).fontDesign(font.design)
    } else {
      content.fontDesign(font.design)
    }
  }
}

/// Settings › Appearance: text size and typeface, with a sample of both.
struct AppearanceSettings: View {
  @AppStorage(AppearanceKey.textSize) private var textSize = TextSizeChoice.system
  @AppStorage(AppearanceKey.font) private var font = FontChoice.standard

  var body: some View {
    Form {
      Section {
        VStack(alignment: .leading, spacing: 4) {
          Text("Fix the failing test")
            .font(.subheadline)
          Text("I found the cause: the date was read in the wrong time zone.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
      } header: {
        Text("Preview")
      }
      Section("Text Size") {
        Picker("Text Size", selection: $textSize) {
          ForEach(TextSizeChoice.allCases) { choice in
            Text(choice.title).tag(choice)
          }
        }
        .pickerStyle(.inline)
        .labelsHidden()
      }
      Section("Font") {
        Picker("Font", selection: $font) {
          ForEach(FontChoice.allCases) { choice in
            Text(choice.title)
              .fontDesign(choice.design)
              .tag(choice)
          }
        }
        .pickerStyle(.inline)
        .labelsHidden()
      }
    }
    .navigationTitle("Appearance")
    .navigationBarTitleDisplayMode(.inline)
  }
}
