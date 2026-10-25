import SwiftUI
import UIKit

/// A provider's logo as vector paths, drawn in the text colour around it.
struct ProviderMark {
  struct Shape {
    let path: Path
    var evenOdd = false
    var opacity: Double = 1
    /// A fixed colour, for the rare mark that has one; nil draws in the current style.
    var color: Color?
    /// Drawn as a line this wide instead of filled.
    var stroke: CGFloat?
    /// Punched out of the shapes before it.
    var cutout = false

    init(
      _ d: String, evenOdd: Bool = false, opacity: Double = 1, color: Color? = nil, stroke: CGFloat? = nil,
      cutout: Bool = false
    ) {
      path = SVGPath.parse(d)
      self.evenOdd = evenOdd
      self.opacity = opacity
      self.color = color
      self.stroke = stroke
      self.cutout = cutout
    }
  }

  let viewBox: CGRect
  let shapes: [Shape]
}

/// A provider's mark, square and as tall as `size`. Unknown marks draw the
/// generic connection mark, so a row never loses its icon.
struct ProviderLogo: View {
  let mark: String
  var size: CGFloat = 14

  var body: some View {
    let logo = ProviderMark.all[mark] ?? ProviderMark.all["custom"]!
    Canvas { context, canvas in
      let box = logo.viewBox
      let scale = min(canvas.width / box.width, canvas.height / box.height)
      var transform = CGAffineTransform(
        translationX: (canvas.width - box.width * scale) / 2, y: (canvas.height - box.height * scale) / 2)
      transform = transform.scaledBy(x: scale, y: scale).translatedBy(x: -box.minX, y: -box.minY)
      let style = GraphicsContext.Shading.foreground
      for shape in logo.shapes {
        let path = shape.path.applying(transform)
        var layer = context
        layer.opacity = shape.opacity
        if shape.cutout { layer.blendMode = .destinationOut }
        let shading = shape.color.map { GraphicsContext.Shading.color($0) } ?? style
        if let width = shape.stroke {
          layer.stroke(path, with: shading, style: StrokeStyle(lineWidth: width * scale, lineCap: .round))
        } else {
          layer.fill(path, with: shading, style: FillStyle(eoFill: shape.evenOdd))
        }
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// SVG path data (the `d` attribute) as a SwiftUI path: every command,
/// absolute and relative, with arcs turned into curves.
enum SVGPath {
  static func parse(_ data: String) -> Path {
    var path = Path()
    var scanner = Scanner(Array(data.utf8))
    var current = CGPoint.zero
    var start = CGPoint.zero
    // The control point a smooth curve mirrors, and which kind of curve set it.
    var lastControl: CGPoint?
    var lastCommand: UInt8 = 0
    var command: UInt8 = 0
    while true {
      if let next = scanner.command() {
        command = next
      } else if !scanner.hasNumber() {
        break
      } else if command == UInt8(ascii: "M") {
        command = UInt8(ascii: "L")
      } else if command == UInt8(ascii: "m") {
        command = UInt8(ascii: "l")
      }
      let relative = command >= UInt8(ascii: "a")
      let base = relative ? current : .zero
      func point() -> CGPoint? {
        guard let x = scanner.number(), let y = scanner.number() else { return nil }
        return CGPoint(x: base.x + x, y: base.y + y)
      }
      switch command | 0x20 {
      case UInt8(ascii: "m"):
        guard let p = point() else { return path }
        path.move(to: p)
        current = p
        start = p
        lastControl = nil
      case UInt8(ascii: "l"):
        guard let p = point() else { return path }
        path.addLine(to: p)
        current = p
        lastControl = nil
      case UInt8(ascii: "h"):
        guard let x = scanner.number() else { return path }
        current = CGPoint(x: (relative ? current.x : 0) + x, y: current.y)
        path.addLine(to: current)
        lastControl = nil
      case UInt8(ascii: "v"):
        guard let y = scanner.number() else { return path }
        current = CGPoint(x: current.x, y: (relative ? current.y : 0) + y)
        path.addLine(to: current)
        lastControl = nil
      case UInt8(ascii: "c"):
        guard let c1 = point(), let c2 = point(), let p = point() else { return path }
        path.addCurve(to: p, control1: c1, control2: c2)
        current = p
        lastControl = c2
      case UInt8(ascii: "s"):
        guard let c2 = point(), let p = point() else { return path }
        let smooth = [UInt8(ascii: "c"), UInt8(ascii: "s")].contains(lastCommand | 0x20)
        let c1 = smooth ? mirror(lastControl, around: current) : current
        path.addCurve(to: p, control1: c1, control2: c2)
        current = p
        lastControl = c2
      case UInt8(ascii: "q"):
        guard let c = point(), let p = point() else { return path }
        path.addQuadCurve(to: p, control: c)
        current = p
        lastControl = c
      case UInt8(ascii: "t"):
        guard let p = point() else { return path }
        let smooth = [UInt8(ascii: "q"), UInt8(ascii: "t")].contains(lastCommand | 0x20)
        let c = smooth ? mirror(lastControl, around: current) : current
        path.addQuadCurve(to: p, control: c)
        current = p
        lastControl = c
      case UInt8(ascii: "a"):
        guard let rx = scanner.number(), let ry = scanner.number(), let rotation = scanner.number(),
          let large = scanner.flag(), let sweep = scanner.flag(), let p = point()
        else { return path }
        addArc(
          to: &path, from: current, to: p, radii: CGSize(width: rx, height: ry), rotation: rotation,
          large: large, sweep: sweep)
        current = p
        lastControl = nil
      case UInt8(ascii: "z"):
        path.closeSubpath()
        current = start
        lastControl = nil
      default:
        return path
      }
      lastCommand = command
    }
    return path
  }

  private static func mirror(_ control: CGPoint?, around point: CGPoint) -> CGPoint {
    guard let control else { return point }
    return CGPoint(x: 2 * point.x - control.x, y: 2 * point.y - control.y)
  }

  /// An elliptical arc as cubic curves, from SVG's endpoint form (SVG 1.1, appendix F.6).
  private static func addArc(
    to path: inout Path, from p0: CGPoint, to p1: CGPoint, radii: CGSize, rotation: CGFloat, large: Bool,
    sweep: Bool
  ) {
    var rx = abs(radii.width)
    var ry = abs(radii.height)
    guard rx > 0, ry > 0, p0 != p1 else {
      path.addLine(to: p1)
      return
    }
    let phi = rotation * .pi / 180
    let cosPhi = cos(phi)
    let sinPhi = sin(phi)
    let dx = (p0.x - p1.x) / 2
    let dy = (p0.y - p1.y) / 2
    let x1 = cosPhi * dx + sinPhi * dy
    let y1 = -sinPhi * dx + cosPhi * dy
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
    if lambda > 1 {
      rx *= lambda.squareRoot()
      ry *= lambda.squareRoot()
    }
    let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
    var factor = (max(0, numerator) / denominator).squareRoot()
    if large == sweep { factor = -factor }
    let cx1 = factor * rx * y1 / ry
    let cy1 = -factor * ry * x1 / rx
    let center = CGPoint(
      x: cosPhi * cx1 - sinPhi * cy1 + (p0.x + p1.x) / 2, y: sinPhi * cx1 + cosPhi * cy1 + (p0.y + p1.y) / 2)
    func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
      atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    }
    let theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
    var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
    if !sweep && delta > 0 { delta -= 2 * .pi }
    if sweep && delta < 0 { delta += 2 * .pi }
    let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
    let step = delta / CGFloat(segments)
    let k = 4 / 3 * tan(step / 4)
    func onEllipse(_ t: CGFloat) -> CGPoint {
      CGPoint(
        x: center.x + rx * cos(t) * cosPhi - ry * sin(t) * sinPhi,
        y: center.y + rx * cos(t) * sinPhi + ry * sin(t) * cosPhi)
    }
    func tangent(_ t: CGFloat) -> CGPoint {
      CGPoint(
        x: -rx * sin(t) * cosPhi - ry * cos(t) * sinPhi, y: -rx * sin(t) * sinPhi + ry * cos(t) * cosPhi)
    }
    var t = theta
    for index in 0..<segments {
      let next = t + step
      let a = onEllipse(t)
      let b = index == segments - 1 ? p1 : onEllipse(next)
      let ta = tangent(t)
      let tb = tangent(next)
      path.addCurve(
        to: b, control1: CGPoint(x: a.x + k * ta.x, y: a.y + k * ta.y),
        control2: CGPoint(x: b.x - k * tb.x, y: b.y - k * tb.y))
      t = next
    }
  }

  /// Reads path data a token at a time: numbers in any spelling SVG allows
  /// (".5.5", "1e-3", "-1-2") and arc flags written without separators ("011").
  private struct Scanner {
    let bytes: [UInt8]
    var index = 0

    init(_ bytes: [UInt8]) { self.bytes = bytes }

    private mutating func skipSeparators() {
      while index < bytes.count, [0x20, 0x2C, 0x0A, 0x0D, 0x09].contains(bytes[index]) { index += 1 }
    }

    mutating func command() -> UInt8? {
      skipSeparators()
      guard index < bytes.count else { return nil }
      let byte = bytes[index]
      let isLetter = (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
      guard isLetter, byte != UInt8(ascii: "e"), byte != UInt8(ascii: "E") else { return nil }
      index += 1
      return byte
    }

    mutating func hasNumber() -> Bool {
      skipSeparators()
      guard index < bytes.count else { return false }
      let byte = bytes[index]
      return (byte >= 0x30 && byte <= 0x39) || byte == UInt8(ascii: "-") || byte == UInt8(ascii: "+")
        || byte == UInt8(ascii: ".")
    }

    mutating func flag() -> Bool? {
      skipSeparators()
      guard index < bytes.count, bytes[index] == 0x30 || bytes[index] == 0x31 else { return nil }
      defer { index += 1 }
      return bytes[index] == 0x31
    }

    mutating func number() -> CGFloat? {
      guard hasNumber() else { return nil }
      let begin = index
      if bytes[index] == UInt8(ascii: "-") || bytes[index] == UInt8(ascii: "+") { index += 1 }
      var dot = false
      while index < bytes.count {
        let byte = bytes[index]
        if byte >= 0x30 && byte <= 0x39 {
          index += 1
        } else if byte == UInt8(ascii: "."), !dot {
          dot = true
          index += 1
        } else if byte == UInt8(ascii: "e") || byte == UInt8(ascii: "E") {
          index += 1
          if index < bytes.count, bytes[index] == UInt8(ascii: "-") || bytes[index] == UInt8(ascii: "+") {
            index += 1
          }
          while index < bytes.count, bytes[index] >= 0x30 && bytes[index] <= 0x39 { index += 1 }
          break
        } else {
          break
        }
      }
      return Double(String(decoding: bytes[begin..<index], as: UTF8.self)).map { CGFloat($0) }
    }
  }
}

/// A provider's mark for UIKit, drawn in the view's tint colour.
final class ProviderMarkView: UIView {
  var mark = "custom" {
    didSet { if mark != oldValue { setNeedsDisplay() } }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    isAccessibilityElement = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func tintColorDidChange() {
    super.tintColorDidChange()
    setNeedsDisplay()
  }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    let logo = ProviderMark.all[mark] ?? ProviderMark.all["custom"]!
    let box = logo.viewBox
    let scale = min(bounds.width / box.width, bounds.height / box.height)
    var transform = CGAffineTransform(
      translationX: (bounds.width - box.width * scale) / 2, y: (bounds.height - box.height * scale) / 2)
    transform = transform.scaledBy(x: scale, y: scale).translatedBy(x: -box.minX, y: -box.minY)
    let ink = tintColor.resolvedColor(with: traitCollection)
    for shape in logo.shapes {
      let path = shape.path.applying(transform).cgPath
      context.saveGState()
      context.setAlpha(shape.opacity)
      if shape.cutout { context.setBlendMode(.clear) }
      let color = shape.color.map { UIColor($0) } ?? ink
      context.addPath(path)
      if let width = shape.stroke {
        context.setStrokeColor(color.cgColor)
        context.setLineWidth(width * scale)
        context.setLineCap(.round)
        context.strokePath()
      } else {
        context.setFillColor(color.cgColor)
        context.fillPath(using: shape.evenOdd ? .evenOdd : .winding)
      }
      context.restoreGState()
    }
  }
}
