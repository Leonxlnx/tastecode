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
  nonisolated(unsafe) private static var parsed: [String: CGPath] = [:]

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
      var transform = CGAffineTransform(scaleX: scale, y: scale)
      let gc = context.cgContext
      if let cg = path.copy(using: &transform) { gc.addPath(cg) }
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

  private static func shape(_ name: String, _ icon: Icon) -> CGPath {
    lock.lock()
    defer { lock.unlock() }
    if let hit = parsed[name] { return hit }
    let path = CGMutablePath()
    for data in icon.paths { path.addPath(SVGPath.parse(data)) }
    parsed[name] = path
    return path
  }
}
