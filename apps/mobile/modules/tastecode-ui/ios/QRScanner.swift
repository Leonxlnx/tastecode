import AVFoundation
import SwiftUI
import UIKit

/// The camera, looking for the pairing code. Reports each new code once, and
/// "denied" or "no_camera" when it cannot look.
struct CameraPreview: UIViewRepresentable {
  let onCode: (String) -> Void
  let onUnavailable: (String) -> Void

  func makeUIView(context: Context) -> ScannerUIView {
    let view = ScannerUIView()
    view.onCode = onCode
    view.onUnavailable = onUnavailable
    view.start()
    return view
  }

  func updateUIView(_ view: ScannerUIView, context: Context) {
    view.onCode = onCode
    view.onUnavailable = onUnavailable
  }

  static func dismantleUIView(_ view: ScannerUIView, coordinator: ()) {
    view.stop()
  }
}

final class ScannerUIView: UIView, AVCaptureMetadataOutputObjectsDelegate {
  var onCode: (String) -> Void = { _ in }
  var onUnavailable: (String) -> Void = { _ in }
  private let session = AVCaptureSession()
  private let sessionQueue = DispatchQueue(label: "dev.tastecode.scanner")
  private var lastCode: String?

  override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
  private var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

  func start() {
    backgroundColor = .black
    previewLayer.session = session
    previewLayer.videoGravity = .resizeAspectFill
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      configure()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        DispatchQueue.main.async {
          granted ? self.configure() : self.onUnavailable("denied")
        }
      }
    default:
      onUnavailable("denied")
    }
  }

  func stop() {
    sessionQueue.async { [session] in
      if session.isRunning { session.stopRunning() }
    }
  }

  private func configure() {
    guard let device = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input)
    else {
      onUnavailable("no_camera")
      return
    }
    let output = AVCaptureMetadataOutput()
    session.beginConfiguration()
    session.addInput(input)
    guard session.canAddOutput(output) else {
      session.commitConfiguration()
      onUnavailable("no_camera")
      return
    }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    session.commitConfiguration()
    sessionQueue.async { [session] in session.startRunning() }
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard let code = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue,
      code != lastCode
    else { return }
    lastCode = code
    UINotificationFeedbackGenerator().notificationOccurred(.success)
    onCode(code)
  }
}
