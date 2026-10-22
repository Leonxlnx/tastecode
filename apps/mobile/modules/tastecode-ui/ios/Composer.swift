import PhotosUI
import SwiftUI
import UIKit

/// What the composer changes: a chat's setup, or the next new chat's.
struct SetupActions {
  var model: (_ sourceKey: String, _ model: String) -> Void
  var effort: (_ effort: String) -> Void
  var access: (_ mode: String) -> Void
}

/// A picture on its way to the computer, shown in the composer until it is sent.
struct PendingImage: Identifiable {
  let id = UUID()
  let image: UIImage
  var path: String?
  var failed = false
}

/// The input: one glass surface holding what you type, what you attach, where
/// it goes (model, reasoning, access) and the button that sends or stops.
struct Composer: View {
  @Environment(AppModel.self) private var model
  let draftKey: String
  let placeholder: String
  let setup: SetupView
  let running: Bool
  let enabled: Bool
  var queue: [QueuedView] = []
  var canSteer = false
  let actions: SetupActions
  /// Sends text and the saved pictures' paths; throws to give the text back.
  let onSend: (String, [String]) async throws -> Void
  var onStop: () -> Void = {}
  var onSteer: (String) -> Void = { _ in }
  var onUnqueue: (String) -> Void = { _ in }

  @State private var text = ""
  @State private var images: [PendingImage] = []
  @State private var sending = false
  @State private var picking = false
  @State private var picked: [PhotosPickerItem] = []
  @State private var takingPhoto = false
  @State private var problem: String?
  @FocusState private var focused: Bool

  private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var uploading: Bool { images.contains { $0.path == nil && !$0.failed } }
  private var canSend: Bool {
    enabled && !sending && !uploading && (!trimmed.isEmpty || images.contains { $0.path != nil })
  }
  private var showsStop: Bool { running && trimmed.isEmpty && images.isEmpty }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !queue.isEmpty {
        QueueLines(items: queue, canSteer: canSteer, onSteer: onSteer, onUnqueue: onUnqueue)
          .padding(.horizontal, 16)
          .padding(.top, 12)
      }
      if !images.isEmpty {
        ImageStrip(images: $images)
          .padding(.horizontal, 12)
          .padding(.top, 12)
      }
      TextField(placeholder, text: $text, axis: .vertical)
        .font(.body)
        .lineLimit(1...7)
        .focused($focused)
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 8)
      HStack(spacing: 2) {
        if setup.images {
          attachMenu
        }
        SetupMenu(setup: setup, actions: actions)
        AccessMenu(setup: setup, actions: actions)
        Spacer(minLength: 4)
        sendButton
      }
      .padding(.leading, 6)
      .padding(.trailing, 8)
      .padding(.bottom, 8)
    }
    .glassEffect(.regular, in: .rect(cornerRadius: 26, style: .continuous))
    .onAppear { text = model.drafts[draftKey] ?? "" }
    .onChange(of: text) { model.drafts[draftKey] = text }
    .photosPicker(isPresented: $picking, selection: $picked, maxSelectionCount: 4, matching: .images)
    .onChange(of: picked) {
      let items = picked
      picked = []
      for item in items { load(item) }
    }
    .fullScreenCover(isPresented: $takingPhoto) {
      CameraPicker { image in add(image) }
        .ignoresSafeArea()
    }
    .problemAlert($problem)
  }

  private var attachMenu: some View {
    Menu {
      Button("Photo Library", systemImage: "photo.on.rectangle") { picking = true }
      if UIImagePickerController.isSourceTypeAvailable(.camera) {
        Button("Take Photo", systemImage: "camera") { takingPhoto = true }
      }
    } label: {
      Image(systemName: "plus")
        .font(.system(size: 17, weight: .regular))
        .frame(width: 36, height: 36)
        .contentShape(.circle)
    }
    .menuOrder(.fixed)
    .foregroundStyle(.primary)
    .accessibilityLabel("Attach")
  }

  private var sendButton: some View {
    Button {
      if showsStop {
        UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
        onStop()
      } else {
        send()
      }
    } label: {
      Image(systemName: showsStop ? "stop.fill" : "arrow.up")
        .font(.system(size: showsStop ? 12 : 15, weight: .bold))
        .contentTransition(.symbolEffect(.replace))
        .foregroundStyle(showsStop || canSend ? Color(.systemBackground) : Color(.tertiaryLabel))
        .frame(width: 22, height: 22)
    }
    .buttonStyle(.glassProminent)
    .buttonBorderShape(.circle)
    .tint(.primary)
    .disabled(!showsStop && !canSend)
    .animation(.snappy(duration: 0.2), value: showsStop)
    .accessibilityLabel(showsStop ? "Stop" : "Send")
  }

  private func send() {
    guard canSend else { return }
    let value = trimmed
    let kept = images
    let paths = kept.compactMap(\.path)
    for image in kept {
      if let path = image.path { model.images[path] = image.image }
    }
    sending = true
    text = ""
    images = []
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    Task {
      do {
        try await onSend(value, paths)
      } catch {
        // Nothing is lost: the prompt goes back into the field.
        text = value
        images = kept
        problem = error.localizedDescription
        UINotificationFeedbackGenerator().notificationOccurred(.error)
      }
      sending = false
    }
  }

  private func load(_ item: PhotosPickerItem) {
    Task {
      guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
        problem = "That picture could not be read."
        return
      }
      add(image)
    }
  }

  private func add(_ image: UIImage) {
    let pending = PendingImage(image: image)
    images.append(pending)
    Task {
      do {
        guard let data = image.scaledForUpload().jpegData(compressionQuality: 0.8) else {
          throw ActionError(message: "That picture could not be prepared.")
        }
        let saved = try await model.request(
          SavedImage.self,
          ["type": "attach", "mimeType": "image/jpeg", "data": data.base64EncodedString()]
        )
        if let index = images.firstIndex(where: { $0.id == pending.id }) {
          images[index].path = saved.path
        }
      } catch {
        images.removeAll { $0.id == pending.id }
        problem = error.localizedDescription
      }
    }
  }
}

/// The model and its reasoning level, in one quiet menu.
struct SetupMenu: View {
  @Environment(AppModel.self) private var model
  let setup: SetupView
  let actions: SetupActions

  var body: some View {
    let source = model.catalog.source(setup.sourceKey)
    let others = model.catalog.sources.filter { $0.key != setup.sourceKey && !$0.models.isEmpty }
    Menu {
      if let source {
        ModelPicker(source: source, selected: setup.model, actions: actions)
      }
      if let efforts = source?.models.first(where: { $0.id == setup.model })?.efforts, !efforts.isEmpty {
        Picker(
          selection: Binding(get: { setup.effort ?? "" }, set: { actions.effort($0) })
        ) {
          ForEach(efforts) { effort in
            Text(effort.label).tag(effort.id)
          }
        } label: {
          Label("Reasoning", systemImage: "brain")
          Text(setup.effortLabel ?? "")
        }
        .pickerStyle(.menu)
      }
      if setup.switchable && !others.isEmpty {
        Section("Other Providers") {
          ForEach(others) { other in
            Menu(other.name) {
              ModelPicker(source: other, selected: nil, actions: actions)
            }
          }
        }
      }
    } label: {
      MenuLabel(text: label, symbol: nil)
    }
    .menuOrder(.fixed)
    .layoutPriority(1)
  }

  private var label: String {
    guard let name = setup.modelName ?? setup.sourceName else { return "Model" }
    guard let effort = setup.effortLabel else { return name }
    return "\(name) · \(effort)"
  }
}

private struct ModelPicker: View {
  let source: SourceView
  let selected: String?
  let actions: SetupActions

  var body: some View {
    let main = source.models.filter { !$0.more }
    let more = source.models.filter(\.more)
    Section(source.name) {
      if source.models.isEmpty {
        Text(source.status == .loading ? "Loading models…" : "No models")
      }
      picker(main)
      if !more.isEmpty {
        Menu("More Models") {
          picker(more)
        }
      }
    }
  }

  private func picker(_ models: [ModelView]) -> some View {
    ForEach(models) { entry in
      Toggle(
        entry.name,
        isOn: Binding(get: { selected == entry.id }, set: { if $0 { actions.model(source.key, entry.id) } })
      )
    }
  }
}

/// How freely the agent may act: ask first, approve itself, or full access.
struct AccessMenu: View {
  @Environment(AppModel.self) private var model
  let setup: SetupView
  let actions: SetupActions

  var body: some View {
    let levels = model.catalog.source(setup.sourceKey)?.access ?? []
    Menu {
      Section("Access") {
        ForEach(levels) { level in
          Toggle(
            isOn: Binding(
              get: { setup.access == level.mode },
              set: { if $0 { actions.access(level.mode) } }
            )
          ) {
            Text(level.title)
            Text(level.detail)
          }
        }
      }
    } label: {
      MenuLabel(text: setup.accessTitle, symbol: setup.access == "full" ? "exclamationmark.shield" : nil)
    }
    .menuOrder(.fixed)
  }
}

/// A composer menu's face: its current value in secondary ink, nothing more.
private struct MenuLabel: View {
  let text: String
  let symbol: String?

  var body: some View {
    HStack(spacing: 4) {
      if let symbol {
        Image(systemName: symbol)
          .font(.footnote)
          .foregroundStyle(.orange)
      }
      Text(text)
        .lineLimit(1)
      Image(systemName: "chevron.down")
        .font(.system(size: 9, weight: .bold))
        .foregroundStyle(.tertiary)
    }
    .font(.subheadline.weight(.medium))
    .foregroundStyle(.secondary)
    .padding(.horizontal, 8)
    .frame(height: 36)
    .contentShape(.rect)
  }
}

private struct QueueLines: View {
  let items: [QueuedView]
  let canSteer: Bool
  let onSteer: (String) -> Void
  let onUnqueue: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(items) { item in
        HStack(spacing: 10) {
          Image(systemName: "arrow.turn.down.right")
            .font(.footnote)
            .foregroundStyle(.tertiary)
          Text(item.text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
          Spacer(minLength: 8)
          if canSteer {
            Button("Send Now") { onSteer(item.id) }
              .font(.subheadline.weight(.medium))
              .buttonStyle(.plain)
          }
          Button {
            onUnqueue(item.id)
          } label: {
            Image(systemName: "xmark")
              .font(.caption.weight(.semibold))
              .foregroundStyle(.secondary)
              .frame(width: 24, height: 24)
              .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Remove from the queue")
        }
      }
    }
  }
}

private struct ImageStrip: View {
  @Binding var images: [PendingImage]

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(images) { pending in
          Image(uiImage: pending.image)
            .resizable()
            .scaledToFill()
            .frame(width: 58, height: 58)
            .clipShape(.rect(cornerRadius: 14, style: .continuous))
            .overlay {
              if pending.path == nil {
                ProgressView()
                  .controlSize(.small)
                  .frame(maxWidth: .infinity, maxHeight: .infinity)
                  .background(.ultraThinMaterial, in: .rect(cornerRadius: 14, style: .continuous))
              }
            }
            .overlay(alignment: .topTrailing) {
              Button {
                images.removeAll { $0.id == pending.id }
              } label: {
                Image(systemName: "xmark.circle.fill")
                  .symbolRenderingMode(.palette)
                  .foregroundStyle(.white, .black.opacity(0.55))
                  .font(.system(size: 18))
              }
              .buttonStyle(.plain)
              .offset(x: 5, y: -5)
              .accessibilityLabel("Remove picture")
            }
        }
      }
      .padding(.top, 5)
      .padding(.trailing, 5)
    }
    .frame(height: 64)
  }
}

extension UIImage {
  /// At most 2048 points on the long side: plenty for an agent to read, quick to send.
  func scaledForUpload(maxSide: CGFloat = 2048) -> UIImage {
    let longest = max(size.width, size.height)
    guard longest > maxSide else { return self }
    let scale = maxSide / longest
    let target = CGSize(width: size.width * scale, height: size.height * scale)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: target, format: format).image { _ in
      draw(in: CGRect(origin: .zero, size: target))
    }
  }
}

/// The system camera, for a photo to attach.
struct CameraPicker: UIViewControllerRepresentable {
  let onPick: (UIImage) -> Void
  @Environment(\.dismiss) private var dismiss

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

  func makeCoordinator() -> Coordinator {
    Coordinator(parent: self)
  }

  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let parent: CameraPicker

    init(parent: CameraPicker) {
      self.parent = parent
    }

    func imagePickerController(
      _ picker: UIImagePickerController,
      didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
      if let image = info[.originalImage] as? UIImage { parent.onPick(image) }
      parent.dismiss()
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
      parent.dismiss()
    }
  }
}
