import AVFoundation
import UIKit
import UniformTypeIdentifiers

/// First run, and whenever the computer no longer knows this phone. The
/// camera is the screen: point it at the code the computer shows.
final class PairingController: UIViewController {
  private let model = AppModel.shared
  private var camera = CameraAccess.current
  private var problem: String?
  private var applied: (link: LinkView, camera: CameraAccess, problem: String?)?

  private let viewfinder = UIView()
  private let spinner = UIActivityIndicatorView(style: .large)
  private var scanner: ScannerUIView?
  private let corners = CAShapeLayer()
  private let allow = UIButton(configuration: .prominentGlass())
  private let denied = UIStackView()
  private let noCamera = UILabel()
  private let heading = UILabel()
  private let instructions = UILabel()
  private let failure = UILabel()
  private let cancel = UIButton(configuration: .glass())
  private let paste: UIPasteControl = {
    let configuration = UIPasteControl.Configuration()
    configuration.displayMode = .iconAndLabel
    configuration.cornerStyle = .capsule
    return UIPasteControl(configuration: configuration)
  }()
  private let pasteHint = UILabel()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.text.identifier, UTType.url.identifier])
    paste.target = self

    viewfinder.backgroundColor = .secondarySystemBackground
    viewfinder.layer.cornerRadius = 36
    viewfinder.layer.cornerCurve = .continuous
    viewfinder.clipsToBounds = true
    corners.strokeColor = UIColor.white.withAlphaComponent(0.9).cgColor
    corners.fillColor = nil
    corners.lineWidth = 4
    corners.lineCap = .round
    corners.lineJoin = .round

    allow.configuration?.title = "Allow Camera"
    allow.configuration?.buttonSize = .large
    allow.tintColor = .label
    allow.addAction(UIAction { [weak self] _ in self?.askForCamera() }, for: .touchUpInside)
    let deniedTitle = UILabel()
    deniedTitle.text = "Camera access is off"
    deniedTitle.font = .app(.headline, traits: traitCollection)
    let settings = UIButton(configuration: .glass())
    settings.configuration?.title = "Open Settings"
    settings.configuration?.baseForegroundColor = .label
    settings.addAction(UIAction { _ in
      if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }, for: .touchUpInside)
    denied.addArrangedSubview(deniedTitle)
    denied.addArrangedSubview(settings)
    denied.axis = .vertical
    denied.alignment = .center
    denied.spacing = 10
    noCamera.text = "No camera here.\nPaste the pairing link instead."
    noCamera.numberOfLines = 0
    noCamera.textAlignment = .center
    noCamera.textColor = .secondaryLabel
    noCamera.font = .app(.subheadline, traits: traitCollection)
    for part in [spinner, allow, denied, noCamera] as [UIView] {
      part.translatesAutoresizingMaskIntoConstraints = false
      viewfinder.addSubview(part)
      NSLayoutConstraint.activate([
        part.centerXAnchor.constraint(equalTo: viewfinder.centerXAnchor),
        part.centerYAnchor.constraint(equalTo: viewfinder.centerYAnchor),
        part.leadingAnchor.constraint(greaterThanOrEqualTo: viewfinder.leadingAnchor, constant: 16),
      ])
    }

    heading.font = .app(.title2, weight: .bold, traits: traitCollection)
    instructions.font = .app(.body, traits: traitCollection)
    instructions.textColor = .secondaryLabel
    failure.font = .app(.subheadline, traits: traitCollection)
    failure.textColor = .systemRed
    for label in [heading, instructions, failure] {
      label.numberOfLines = 0
      label.textAlignment = .center
    }
    let words = UIStackView(arrangedSubviews: [heading, instructions, failure])
    words.axis = .vertical
    words.spacing = 10
    words.setCustomSpacing(14, after: instructions)

    cancel.configuration?.title = "Cancel"
    cancel.configuration?.buttonSize = .large
    cancel.configuration?.baseForegroundColor = .label
    cancel.addAction(UIAction { [weak self] _ in self?.model.send(["type": "forget"]) }, for: .touchUpInside)
    pasteHint.text = "No camera? Choose Copy Link on the computer, then Paste here."
    pasteHint.font = .app(.footnote, traits: traitCollection)
    pasteHint.textColor = .tertiaryLabel
    pasteHint.textAlignment = .center
    pasteHint.numberOfLines = 0

    let above = UILayoutGuide()
    let below = UILayoutGuide()
    view.addLayoutGuide(above)
    view.addLayoutGuide(below)
    for part in [viewfinder, words, cancel, paste, pasteHint] as [UIView] {
      part.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(part)
    }
    let safe = view.safeAreaLayoutGuide
    let wide = viewfinder.widthAnchor.constraint(equalTo: safe.widthAnchor, constant: -56)
    wide.priority = .defaultHigh
    NSLayoutConstraint.activate([
      // The space above the viewfinder and under the words share what is left, as two spacers do.
      above.topAnchor.constraint(equalTo: safe.topAnchor),
      above.heightAnchor.constraint(greaterThanOrEqualToConstant: 16),
      viewfinder.topAnchor.constraint(equalTo: above.bottomAnchor),
      viewfinder.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
      viewfinder.widthAnchor.constraint(lessThanOrEqualToConstant: 340),
      viewfinder.widthAnchor.constraint(lessThanOrEqualTo: safe.widthAnchor, constant: -56),
      wide,
      // As tall as the space it could be wide, as the SwiftUI screen drew it: a little taller than wide.
      viewfinder.heightAnchor.constraint(equalTo: safe.widthAnchor, constant: -56),
      words.topAnchor.constraint(equalTo: viewfinder.bottomAnchor, constant: 36),
      words.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 32),
      words.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -32),
      below.topAnchor.constraint(equalTo: words.bottomAnchor),
      below.heightAnchor.constraint(equalTo: above.heightAnchor),
      paste.topAnchor.constraint(equalTo: below.bottomAnchor),
      paste.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
      pasteHint.topAnchor.constraint(equalTo: paste.bottomAnchor, constant: 12),
      pasteHint.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 32),
      pasteHint.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -32),
      pasteHint.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -8),
      cancel.bottomAnchor.constraint(equalTo: pasteHint.bottomAnchor, constant: 4),
      cancel.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
    ])
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    scanner?.frame = viewfinder.bounds
    corners.frame = viewfinder.bounds
    corners.path = Self.corners(in: viewfinder.bounds.insetBy(dx: 46, dy: 46))
  }

  /// UIKit runs this again whenever the link changes.
  override func updateProperties() {
    super.updateProperties()
    guard let link = model.link else { return }
    if let applied, applied.link == link, applied.camera == camera, applied.problem == problem { return }
    if applied?.link.pairing == true && !link.pairing { problem = nil }
    applied = (link, camera, problem)
    // A code was read and the computer has not answered yet. Once it refuses
    // the code, the screen offers the camera and Paste again for a new one.
    let waiting = link.pairing && link.phase != .refused
    heading.text = waiting ? "Pairing with \(link.computerName ?? "your computer")" : "Pair with your computer"
    instructions.text =
      waiting
      ? "Waiting for the computer to answer."
      : "In TasteCode on your computer, open Settings › Phone and show the pairing code, then scan it."
    let failed = problem ?? (link.phase == .refused || link.phase == .waiting ? link.error : nil)
    failure.text = failed
    failure.isHidden = failed == nil
    cancel.isHidden = !waiting
    paste.isHidden = waiting
    pasteHint.isHidden = waiting
    pasteHint.alpha = waiting ? 0 : 1
    if waiting { spinner.startAnimating() } else { spinner.stopAnimating() }
    let looking = !waiting && camera == .authorized
    allow.isHidden = waiting || camera != .notDetermined
    denied.isHidden = waiting || camera != .denied
    noCamera.isHidden = waiting || camera != .unavailable
    if looking { startScanner() } else { stopScanner() }
  }

  // MARK: Camera

  private func askForCamera() {
    AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
      Task { @MainActor in
        self?.camera = granted ? .authorized : .denied
        self?.setNeedsUpdateProperties()
      }
    }
  }

  private func startScanner() {
    guard scanner == nil else { return }
    let scanner = ScannerUIView()
    scanner.onCode = { [weak self] code in self?.pair(code) }
    scanner.onUnavailable = { [weak self] reason in
      self?.camera = reason == "denied" ? .denied : .unavailable
      self?.setNeedsUpdateProperties()
    }
    scanner.frame = viewfinder.bounds
    viewfinder.insertSubview(scanner, at: 0)
    viewfinder.layer.addSublayer(corners)
    scanner.start()
    self.scanner = scanner
  }

  private func stopScanner() {
    scanner?.stop()
    scanner?.removeFromSuperview()
    scanner = nil
    corners.removeFromSuperlayer()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    stopScanner()
  }

  // MARK: Pairing

  override func paste(itemProviders: [NSItemProvider]) {
    guard let provider = itemProviders.first, provider.canLoadObject(ofClass: String.self) else { return }
    _ = provider.loadObject(ofClass: String.self) { [weak self] text, _ in
      guard let text else { return }
      Task { @MainActor in self?.pair(text, pasted: true) }
    }
  }

  private func pair(_ text: String, pasted: Bool = false) {
    problem = nil
    setNeedsUpdateProperties()
    Task {
      do {
        _ = try await model.request(["type": "pair", "link": text])
        // The link pairs once; it should not wait in the clipboard for the next paste.
        if pasted { UIPasteboard.general.items = [] }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
      } catch {
        problem = error.localizedDescription
        setNeedsUpdateProperties()
        UINotificationFeedbackGenerator().notificationOccurred(.error)
      }
    }
  }

  /// Four corner marks: where the code goes.
  private static func corners(in rect: CGRect) -> CGPath {
    let arm = min(rect.width, rect.height) * 0.16
    let path = UIBezierPath()
    let marks: [(CGPoint, CGFloat, CGFloat)] = [
      (CGPoint(x: rect.minX, y: rect.minY), 1, 1),
      (CGPoint(x: rect.maxX, y: rect.minY), -1, 1),
      (CGPoint(x: rect.minX, y: rect.maxY), 1, -1),
      (CGPoint(x: rect.maxX, y: rect.maxY), -1, -1),
    ]
    for (point, dx, dy) in marks {
      path.move(to: CGPoint(x: point.x, y: point.y + dy * arm))
      path.addLine(to: point)
      path.addLine(to: CGPoint(x: point.x + dx * arm, y: point.y))
    }
    return path.cgPath
  }
}

private enum CameraAccess {
  case authorized, notDetermined, denied, unavailable

  static var current: CameraAccess {
    guard AVCaptureDevice.default(for: .video) != nil else { return .unavailable }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: return .authorized
    case .notDetermined: return .notDetermined
    default: return .denied
    }
  }
}
