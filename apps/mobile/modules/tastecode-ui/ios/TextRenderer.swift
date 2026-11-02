import CoreVideo
import IOSurface
import UIKit

/// A piece of text as it is drawn: the string, the size it fills, and the
/// screen's scale and appearance. Keys match only for the very same string
/// object, which the layout cache hands out again while the text is unchanged.
final class TextImageKey: NSObject, @unchecked Sendable {
  let text: NSAttributedString
  let size: CGSize
  let scale: CGFloat
  let dark: Bool
  let highContrast: Bool
  /// What the text's colours resolve against; not part of what makes two keys equal.
  let traits: UITraitCollection

  init(text: NSAttributedString, size: CGSize, traits: UITraitCollection) {
    self.text = text
    self.size = size
    scale = max(traits.displayScale, 1)
    dark = traits.userInterfaceStyle == .dark
    highContrast = traits.accessibilityContrast == .high
    self.traits = traits
  }

  override var hash: Int {
    var hasher = Hasher()
    hasher.combine(ObjectIdentifier(text))
    hasher.combine(size.width)
    hasher.combine(size.height)
    hasher.combine(scale)
    hasher.combine(dark)
    hasher.combine(highContrast)
    return hasher.finalize()
  }

  override func isEqual(_ object: Any?) -> Bool {
    guard let other = object as? TextImageKey else { return false }
    return text === other.text && size == other.size && scale == other.scale && dark == other.dark
      && highContrast == other.highContrast
  }
}

/// Draws the transcript's text into bitmaps off the main thread, so the main
/// thread only hands finished pictures to Core Animation: a streaming reply or
/// a fast scroll never waits for text to be set. Pictures are kept for a while,
/// so text scrolled away and back is not drawn again.
///
/// Each picture is an IOSurface, memory the screen's compositor reads in
/// place; a plain bitmap would be copied over to it on every commit.
final class TextRenderer: @unchecked Sendable {
  static let shared = TextRenderer()

  /// Lets a render nobody wants any more be skipped before it starts.
  final class Ticket: @unchecked Sendable {
    private let lock = NSLock()
    private var isCancelled = false
    var cancelled: Bool { lock.withLock { isCancelled } }
    func cancel() { lock.withLock { isCancelled = true } }
  }

  private final class Picture {
    let surface: IOSurface
    init(_ surface: IOSurface) { self.surface = surface }
  }

  private let cache = NSCache<TextImageKey, Picture>()
  /// Both kinds of render serve what is about to show, so neither waits behind other work.
  private let queue = DispatchQueue(label: "tastecode.text.render", qos: .userInitiated, attributes: .concurrent)
  /// Renders under way, with whoever waits for each. Locked rather than kept
  /// on the main thread, so a render nobody waits for never wakes it.
  private let lock = NSLock()
  private var waiting: [TextImageKey: [@MainActor (IOSurface?) -> Void]] = [:]

  private init() {
    // About four screens of text.
    cache.totalCostLimit = 48 * 1024 * 1024
  }

  func cached(_ key: TextImageKey) -> IOSurface? {
    cache.object(forKey: key)?.surface
  }

  /// Draws on the calling thread, for text that has to show in this frame.
  func renderNow(_ key: TextImageKey) -> IOSurface? {
    if let hit = cached(key) { return hit }
    let image = Self.draw(key)
    store(image, key)
    return image
  }

  /// Draws in the background and answers on the main thread. The picture is
  /// kept for next time unless `keep` is false, as for the passing states of a
  /// streaming reply.
  @MainActor func render(
    _ key: TextImageKey, keep: Bool, ticket: Ticket, done: @escaping @MainActor (IOSurface?) -> Void
  ) {
    if let hit = cached(key) { return done(hit) }
    let joined = lock.withLock {
      guard waiting[key] != nil else {
        waiting[key] = [done]
        return false
      }
      waiting[key]?.append(done)
      return true
    }
    if joined { return }
    queue.async {
      let image = ticket.cancelled ? nil : Self.draw(key)
      if keep { self.store(image, key) }
      self.answer(key, image)
    }
  }

  /// Draws text that is about to scroll into view, so it is ready when it does.
  func prefetch(_ key: TextImageKey) {
    guard cached(key) == nil else { return }
    let started = lock.withLock {
      guard waiting[key] == nil else { return false }
      waiting[key] = []
      return true
    }
    guard started else { return }
    queue.async {
      let image = Self.draw(key)
      self.store(image, key)
      self.answer(key, image)
    }
  }

  private func answer(_ key: TextImageKey, _ image: IOSurface?) {
    let callbacks = lock.withLock { waiting.removeValue(forKey: key) ?? [] }
    guard !callbacks.isEmpty else { return }
    DispatchQueue.main.async {
      MainActor.assumeIsolated {
        for callback in callbacks { callback(image) }
      }
    }
  }

  private func store(_ surface: IOSurface?, _ key: TextImageKey) {
    guard let surface else { return }
    cache.setObject(Picture(surface), forKey: key, cost: surface.allocationSize)
  }

  private static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
  /// Tells the compositor which colours the pixels are in.
  private static let colorSpaceProperties = colorSpace.copyPropertyList()
  private static let colorKeys: [NSAttributedString.Key] = [
    .foregroundColor, .backgroundColor, .underlineColor, .strikethroughColor,
  ]

  /// The text drawn by the same string drawing that measured it, into a bitmap
  /// the size of its frame at the screen's scale. Safe on any thread.
  static func draw(_ key: TextImageKey) -> IOSurface? {
    let width = Int(ceil(key.size.width * key.scale))
    let height = Int(ceil(key.size.height * key.scale))
    guard width > 0, height > 0, width <= 8192, height <= 8192,
      let surface = IOSurface(properties: [
        .width: width, .height: height, .bytesPerElement: 4,
        .bytesPerRow: IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, width * 4),
        .pixelFormat: kCVPixelFormatType_32BGRA,
      ])
    else { return nil }
    if let colorSpaceProperties {
      IOSurfaceSetValue(surface, kIOSurfaceColorSpace, colorSpaceProperties)
    }
    surface.lock(options: [], seed: nil)
    defer { surface.unlock(options: [], seed: nil) }
    guard
      let context = CGContext(
        data: surface.baseAddress, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: surface.bytesPerRow, space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    context.clear(CGRect(x: 0, y: 0, width: width, height: height))
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: key.scale, y: -key.scale)
    let text = resolved(key.text, traits: key.traits)
    UIGraphicsPushContext(context)
    key.traits.performAsCurrent {
      text.draw(
        with: CGRect(x: 0, y: 0, width: key.size.width, height: .greatestFiniteMagnitude),
        options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    }
    UIGraphicsPopContext()
    context.flush()
    return surface
  }

  /// The text with its system colours fixed for one appearance, since drawing
  /// off the main thread has no view to resolve them against.
  private static func resolved(_ text: NSAttributedString, traits: UITraitCollection) -> NSAttributedString {
    let copy = NSMutableAttributedString(attributedString: text)
    let all = NSRange(location: 0, length: copy.length)
    for name in colorKeys {
      copy.enumerateAttribute(name, in: all) { value, range, _ in
        guard let color = value as? UIColor else { return }
        copy.addAttribute(name, value: color.resolvedColor(with: traits), range: range)
      }
    }
    return copy
  }
}
