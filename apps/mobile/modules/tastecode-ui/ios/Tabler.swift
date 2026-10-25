import SwiftUI
import UIKit

/// The app's icons: Tabler, as on the desktop, drawn from path data into
/// template images, so menus, toolbars, swipe actions and UIKit views take
/// them wherever an SF Symbol would go and tint them the same way.
enum Tabler {
  struct Icon {
    /// Drawn filled rather than as Tabler's outline.
    let filled: Bool
    let paths: [String]
  }

  /// The outline's width on Tabler's 24-point grid, as the desktop draws it.
  static let stroke: CGFloat = 1.75

  private static let lock = NSLock()
  nonisolated(unsafe) private static var cache: [String: UIImage] = [:]
  nonisolated(unsafe) private static var parsed: [String: Path] = [:]

  /// An icon `size` points square, scaled with the reader's text size unless
  /// `fixed`. Safe on any thread, so text laid out off the main thread can use it.
  static func image(_ name: String, size: CGFloat = 20, fixed: Bool = false) -> UIImage {
    let points = fixed ? size : UIFontMetrics.default.scaledValue(for: size)
    let key = "\(name)@\(points)"
    lock.lock()
    if let hit = cache[key] {
      lock.unlock()
      return hit
    }
    lock.unlock()
    let icon = icons[name] ?? icons["circle-dashed"]!
    let path = shape(name, icon)
    let format = UIGraphicsImageRendererFormat.preferred()
    let drawn = UIGraphicsImageRenderer(size: CGSize(width: points, height: points), format: format).image { context in
      let scale = points / 24
      let cg = path.applying(CGAffineTransform(scaleX: scale, y: scale)).cgPath
      let gc = context.cgContext
      gc.addPath(cg)
      gc.setFillColor(UIColor.black.cgColor)
      gc.setStrokeColor(UIColor.black.cgColor)
      if icon.filled {
        gc.fillPath()
      } else {
        gc.setLineWidth(stroke * scale)
        gc.setLineCap(.round)
        gc.setLineJoin(.round)
        gc.strokePath()
      }
    }.withRenderingMode(.alwaysTemplate)
    lock.lock()
    cache[key] = drawn
    lock.unlock()
    return drawn
  }

  private static func shape(_ name: String, _ icon: Icon) -> Path {
    lock.lock()
    defer { lock.unlock() }
    if let hit = parsed[name] { return hit }
    var path = Path()
    for data in icon.paths { path.addPath(SVGPath.parse(data)) }
    parsed[name] = path
    return path
  }
}

extension Image {
  /// A Tabler icon, tinted like a symbol by the foreground style.
  init(tabler name: String, size: CGFloat = 20, fixed: Bool = false) {
    self.init(uiImage: Tabler.image(name, size: size, fixed: fixed))
  }
}

extension Label where Title == Text, Icon == Image {
  /// A label whose icon is a Tabler icon, for menus, buttons and swipe actions.
  init(_ title: String, tabler name: String, size: CGFloat = 20) {
    self.init { Text(title) } icon: { Image(tabler: name, size: size) }
  }
}

extension Button where Label == SwiftUI.Label<Text, Image> {
  init(_ title: String, tabler: String, role: ButtonRole? = nil, action: @escaping @MainActor () -> Void) {
    self.init(role: role, action: action) { SwiftUI.Label(title, tabler: tabler) }
  }
}

extension Picker where Label == SwiftUI.Label<Text, Image> {
  init(
    _ title: String, tabler: String, selection: Binding<SelectionValue>, @ViewBuilder content: () -> Content
  ) {
    self.init(selection: selection, content: content) { SwiftUI.Label(title, tabler: tabler) }
  }
}

extension Toggle where Label == SwiftUI.Label<Text, Image> {
  init(_ title: String, tabler: String, isOn: Binding<Bool>) {
    self.init(isOn: isOn) { SwiftUI.Label(title, tabler: tabler) }
  }
}

extension ContentUnavailableView where Label == SwiftUI.Label<Text, Image>, Description == Text?, Actions == EmptyView {
  init(_ title: String, tabler: String, description: Text? = nil) {
    self.init {
      SwiftUI.Label(title, tabler: tabler, size: 48)
    } description: {
      description
    } actions: {}
  }
}

/// A sheet's close button, the Tabler cross in the toolbar's glass.
struct CloseButton: View {
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(tabler: "x", size: 22)
    }
    .accessibilityLabel("Close")
  }
}
