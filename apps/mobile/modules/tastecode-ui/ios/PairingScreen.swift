import AVFoundation
import SwiftUI
import UIKit

/// First run, and whenever the computer no longer knows this phone. The
/// camera is the screen: point it at the code the computer shows.
struct PairingScreen: View {
  @Environment(AppModel.self) private var model
  let link: LinkView
  @State private var problem: String?
  @State private var camera = CameraAccess.current

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 16)
      viewfinder
        .frame(maxWidth: 340)
        .aspectRatio(1, contentMode: .fit)
        .padding(.horizontal, 28)
      VStack(spacing: 10) {
        Text(waiting ? "Pairing with \(link.computerName ?? "your computer")" : "Pair with your computer")
          .font(.title2.weight(.bold))
        Text(instructions)
          .font(.body)
          .foregroundStyle(.secondary)
        if let failure {
          Text(failure)
            .font(.subheadline)
            .foregroundStyle(.red)
            .padding(.top, 4)
        }
      }
      .multilineTextAlignment(.center)
      .padding(.horizontal, 32)
      .padding(.top, 36)
      Spacer()
      if waiting {
        Button("Cancel") { model.send(["type": "forget"]) }
          .buttonStyle(.glass)
          .controlSize(.large)
          .padding(.bottom, 12)
      } else {
        PasteButton(payloadType: String.self) { strings in
          guard let text = strings.first else { return }
          Task { @MainActor in pair(text, pasted: true) }
        }
        .buttonBorderShape(.capsule)
        .labelStyle(.titleAndIcon)
        .padding(.bottom, 12)
        Text("No camera? Choose Copy Link on the computer, then Paste here.")
          .font(.footnote)
          .foregroundStyle(.tertiary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 32)
          .padding(.bottom, 8)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(.systemBackground))
    .onChange(of: link.pairing) {
      if !link.pairing { problem = nil }
    }
  }

  /// A code was read and the computer has not answered yet. Once it refuses the
  /// code, the screen offers the camera and Paste again for a new one.
  private var waiting: Bool { link.pairing && link.phase != .refused }

  private var instructions: String {
    if waiting { return "Waiting for the computer to answer." }
    return "In TasteCode on your computer, open Settings › Phone and show the pairing code, then scan it."
  }

  private var failure: String? {
    problem ?? (link.phase == .refused || link.phase == .waiting ? link.error : nil)
  }

  @ViewBuilder private var viewfinder: some View {
    let shape = RoundedRectangle(cornerRadius: 36, style: .continuous)
    ZStack {
      shape.fill(Color(.secondarySystemBackground))
      if waiting {
        ProgressView()
          .controlSize(.large)
      } else {
        switch camera {
        case .authorized:
          CameraPreview(onCode: { pair($0) }, onUnavailable: { reason in
            camera = reason == "denied" ? .denied : .unavailable
          })
          .clipShape(shape)
          Corners()
            .stroke(.white.opacity(0.9), style: StrokeStyle(lineWidth: 4, lineCap: .round))
            .padding(46)
        case .notDetermined:
          Button("Allow Camera") {
            AVCaptureDevice.requestAccess(for: .video) { granted in
              Task { @MainActor in camera = granted ? .authorized : .denied }
            }
          }
          .buttonStyle(.glassProminent)
          .controlSize(.large)
        case .denied:
          VStack(spacing: 10) {
            Text("Camera access is off")
              .font(.headline)
            Button("Open Settings") {
              if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
              }
            }
            .buttonStyle(.glass)
          }
        case .unavailable:
          Text("No camera here.\nPaste the pairing link instead.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }
      }
    }
  }

  private func pair(_ text: String, pasted: Bool = false) {
    problem = nil
    Task {
      do {
        _ = try await model.request(["type": "pair", "link": text])
        // The link pairs once; it should not wait in the clipboard for the next paste.
        if pasted { UIPasteboard.general.items = [] }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
      } catch {
        problem = error.localizedDescription
        UINotificationFeedbackGenerator().notificationOccurred(.error)
      }
    }
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

/// Four corner marks: where the code goes.
private struct Corners: Shape {
  func path(in rect: CGRect) -> Path {
    let arm = min(rect.width, rect.height) * 0.16
    var path = Path()
    let corners: [(CGPoint, CGFloat, CGFloat)] = [
      (CGPoint(x: rect.minX, y: rect.minY), 1, 1),
      (CGPoint(x: rect.maxX, y: rect.minY), -1, 1),
      (CGPoint(x: rect.minX, y: rect.maxY), 1, -1),
      (CGPoint(x: rect.maxX, y: rect.maxY), -1, -1),
    ]
    for (point, dx, dy) in corners {
      path.move(to: CGPoint(x: point.x, y: point.y + dy * arm))
      path.addLine(to: point)
      path.addLine(to: CGPoint(x: point.x + dx * arm, y: point.y))
    }
    return path
  }
}
