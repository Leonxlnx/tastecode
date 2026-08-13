@preconcurrency import AVFoundation
import SwiftUI
import UIKit

struct QRScannerView: UIViewControllerRepresentable {
  let onCode: @MainActor (String) -> Void

  func makeUIViewController(context: Context) -> ScannerViewController {
    ScannerViewController(onCode: onCode)
  }

  func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}
}

@MainActor
final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  private let captureSession = AVCaptureSession()
  private let onCode: @MainActor (String) -> Void
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var delivered = false

  init(onCode: @escaping @MainActor (String) -> Void) {
    self.onCode = onCode
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: configureSession()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        Task { @MainActor in
          if granted { self?.configureSession() }
        }
      }
    default: break
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer?.frame = view.bounds
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    if !captureSession.isRunning { captureSession.startRunning() }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    if captureSession.isRunning { captureSession.stopRunning() }
  }

  private func configureSession() {
    guard previewLayer == nil,
      let camera = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: camera),
      captureSession.canAddInput(input)
    else { return }
    captureSession.beginConfiguration()
    captureSession.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard captureSession.canAddOutput(output) else {
      captureSession.commitConfiguration()
      return
    }
    captureSession.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    captureSession.commitConfiguration()

    let layer = AVCaptureVideoPreviewLayer(session: captureSession)
    layer.videoGravity = .resizeAspectFill
    view.layer.addSublayer(layer)
    previewLayer = layer
    layer.frame = view.bounds
    captureSession.startRunning()
  }

  nonisolated func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
      let value = object.stringValue,
      value.hasPrefix("harness://pair")
    else { return }
    Task { @MainActor [weak self] in self?.deliver(value) }
  }

  private func deliver(_ value: String) {
    guard !delivered else { return }
    delivered = true
    captureSession.stopRunning()
    onCode(value)
  }
}
