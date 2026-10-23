import PhotosUI
import SwiftUI
import UIKit

/// What the composer changes: a chat's setup, or the next new chat's.
struct SetupActions {
  var model: (_ sourceKey: String, _ model: String) -> Void
  var effort: (_ effort: String) -> Void
  /// A faster routing the model offers, or nil for the standard one.
  var tier: (_ tier: String?) -> Void
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
  var onReorder: (String, _ index: Int) -> Void = { _, _ in }
  /// Takes a queued prompt out of the queue, for the composer to hold again.
  var onEdit: ((String) async throws -> TakenPrompt)?

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
  /// Brings a queued prompt back into the input, ahead of anything typed since.
  private func edit(_ id: String) {
    guard let onEdit else { return }
    Task {
      do {
        let taken = try await onEdit(id)
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        text = typed.isEmpty ? taken.text : "\(taken.text)\n\n\(text)"
        let placeholder = UIImage(systemName: "photo") ?? UIImage()
        for path in taken.attachments where !images.contains(where: { $0.path == path }) {
          images.append(PendingImage(image: model.images[path] ?? placeholder, path: path))
        }
        focused = true
      } catch {
        problem = error.localizedDescription
      }
    }
  }

  private var showsStop: Bool { running && trimmed.isEmpty && images.isEmpty }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !queue.isEmpty {
        QueueLines(
          items: queue, canSteer: canSteer, canEdit: onEdit != nil, onSteer: onSteer, onUnqueue: onUnqueue,
          onReorder: onReorder, onEdit: edit)
          .padding(.horizontal, 16)
          .padding(.top, 14)
          .transition(.opacity.combined(with: .move(edge: .bottom)))
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
        EffortMenu(setup: setup, actions: actions)
        AccessMenu(setup: setup, actions: actions)
        Spacer(minLength: 4)
        sendButton
      }
      .padding(.leading, 6)
      .padding(.trailing, 8)
      .padding(.bottom, 8)
    }
    .animation(.smooth(duration: 0.32), value: queue.isEmpty)
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
      if let tiers = source?.models.first(where: { $0.id == setup.model })?.tiers, !tiers.isEmpty {
        Picker(
          selection: Binding(get: { setup.tier ?? "" }, set: { actions.tier($0.isEmpty ? nil : $0) })
        ) {
          Text("Standard").tag("")
          ForEach(tiers) { tier in
            Text(tier.name).tag(tier.id)
          }
        } label: {
          Label("Speed", systemImage: "hare")
          Text(setup.tierName ?? "Standard")
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
    return ([name] + [setup.tierName].compactMap { $0 }).joined(separator: " · ")
  }
}

/// How hard the model thinks, beside the model; absent when the model has no levels.
struct EffortMenu: View {
  @Environment(AppModel.self) private var model
  let setup: SetupView
  let actions: SetupActions

  var body: some View {
    let efforts = model.catalog.source(setup.sourceKey)?.models.first(where: { $0.id == setup.model })?.efforts ?? []
    if !efforts.isEmpty {
      Menu {
        Picker("Reasoning", selection: Binding(get: { setup.effort ?? "" }, set: { actions.effort($0) })) {
          ForEach(efforts) { effort in
            Text(effort.label).tag(effort.id)
          }
        }
        .pickerStyle(.inline)
      } label: {
        MenuLabel(text: setup.effortLabel ?? "Effort", symbol: nil)
      }
      .menuOrder(.fixed)
    }
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
      Image(systemName: symbol)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(setup.access == "full" ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
        .frame(width: 36, height: 36)
        .contentShape(.rect)
    }
    .menuOrder(.fixed)
    .accessibilityLabel("Access: \(setup.accessTitle)")
  }

  /// One symbol per level, so the level reads without its name.
  private var symbol: String {
    switch setup.access {
    case "ask": return "hand.raised"
    case "auto", "auto-review": return "checkmark.shield"
    case "full": return "exclamationmark.shield"
    default: return "shield"
    }
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

/// What waits behind the running turn, in the order it will run. Drag a
/// prompt by its handle to reorder, tap it to edit, long-press for the rest.
private struct QueueLines: View {
  let items: [QueuedView]
  let canSteer: Bool
  let canEdit: Bool
  let onSteer: (String) -> Void
  let onUnqueue: (String) -> Void
  let onReorder: (String, _ index: Int) -> Void
  let onEdit: (String) -> Void

  @State private var dragging: String?
  @State private var dragOffset: CGFloat = 0
  @State private var heights: [String: CGFloat] = [:]
  /// The order a drop chose, shown until the queue itself arrives in it.
  @State private var dropped: [String]?
  private let spacing: CGFloat = 2

  private var shown: [QueuedView] {
    guard let dropped else { return items }
    let byId = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
    let ordered = dropped.compactMap { byId[$0] }
    return ordered.count == items.count ? ordered : items
  }

  var body: some View {
    let rows = shown
    VStack(alignment: .leading, spacing: 0) {
      Text(rows.count == 1 ? "Up next" : "Up next · \(rows.count)")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.bottom, 6)
      VStack(alignment: .leading, spacing: spacing) {
        ForEach(rows) { item in
          row(item, in: rows)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { heights[item.id] = $0 }
            .offset(y: offset(of: item.id, in: rows))
            .zIndex(dragging == item.id ? 1 : 0)
            .transition(
              .asymmetric(
                insertion: .opacity.combined(with: .offset(y: 10)),
                removal: .opacity.combined(with: .scale(scale: 0.96, anchor: .leading))))
        }
      }
      Divider()
        .padding(.top, 10)
    }
    .animation(.smooth(duration: 0.32), value: items)
    .onChange(of: items.map(\.id)) { dropped = nil }
  }

  private func row(_ item: QueuedView, in rows: [QueuedView]) -> some View {
    let lifted = dragging == item.id
    return HStack(alignment: .center, spacing: 6) {
      Image(systemName: "line.3.horizontal")
        .font(.footnote.weight(.medium))
        .foregroundStyle(.tertiary)
        .frame(width: 28, height: 36)
        .contentShape(.rect)
        .gesture(item.pending || rows.count < 2 ? nil : drag(item, in: rows))
        .accessibilityLabel("Reorder")
      Button {
        onEdit(item.id)
      } label: {
        VStack(alignment: .leading, spacing: 3) {
          if !item.text.isEmpty {
            Text(item.text)
              .font(.subheadline)
              .foregroundStyle(.primary)
              .lineLimit(2)
              .multilineTextAlignment(.leading)
          }
          if item.images > 0 {
            Label(item.images == 1 ? "1 picture" : "\(item.images) pictures", systemImage: "photo")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .disabled(!canEdit || item.pending)
      .accessibilityHint("Edit")
      if canSteer && !item.pending {
        Button {
          onSteer(item.id)
        } label: {
          Image(systemName: "arrow.up.circle")
            .font(.body)
            .frame(width: 30, height: 30)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Send now")
      }
      Button {
        onUnqueue(item.id)
      } label: {
        Image(systemName: "xmark")
          .font(.caption.weight(.semibold))
          .frame(width: 30, height: 30)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .foregroundStyle(.tertiary)
      .disabled(item.pending)
      .accessibilityLabel("Remove from the queue")
    }
    .padding(.vertical, 2)
    .padding(.trailing, 4)
    .background {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(Color(.systemBackground))
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
        .opacity(lifted ? 1 : 0)
    }
    .scaleEffect(lifted ? 1.02 : 1)
    .opacity(item.pending ? 0.5 : 1)
    .contentShape(.rect)
    .contextMenu {
      if canEdit && !item.pending {
        Button("Edit", systemImage: "pencil") { onEdit(item.id) }
      }
      if canSteer && !item.pending {
        Button("Send Now", systemImage: "arrow.up.circle") { onSteer(item.id) }
      }
      if item.id != rows.first?.id && !item.pending {
        Button("Move to Top", systemImage: "arrow.up.to.line") { reorder(item.id, to: 0, in: rows) }
      }
      Button("Remove", systemImage: "trash", role: .destructive) { onUnqueue(item.id) }
        .disabled(item.pending)
    } preview: {
      // The row lives on the composer's glass; lifted alone it needs its own ground.
      VStack(alignment: .leading, spacing: 4) {
        Text("Queued \((rows.firstIndex(of: item) ?? 0) + 1) of \(rows.count)")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        Text(item.text.isEmpty ? "Pictures only" : item.text)
          .font(.subheadline)
      }
      .padding(16)
      .frame(width: 300, alignment: .leading)
      .background(Color(.systemBackground))
    }
  }

  private func drag(_ item: QueuedView, in rows: [QueuedView]) -> some Gesture {
    // Measured on the screen: the handle moves with the finger, so its own space would halve the drag.
    DragGesture(minimumDistance: 2, coordinateSpace: .global)
      .onChanged { value in
        if dragging == nil {
          withAnimation(.smooth(duration: 0.2)) { dragging = item.id }
          UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
        let before = target(of: item.id, in: rows)
        dragOffset = value.translation.height
        if target(of: item.id, in: rows) != before {
          UISelectionFeedbackGenerator().selectionChanged()
        }
      }
      .onEnded { _ in
        let to = target(of: item.id, in: rows)
        withAnimation(.smooth(duration: 0.28)) {
          if to != rows.firstIndex(of: item) {
            reorder(item.id, to: to, in: rows)
          }
          dragging = nil
          dragOffset = 0
        }
      }
  }

  private func reorder(_ id: String, to index: Int, in rows: [QueuedView]) {
    var order = rows.map(\.id)
    guard let from = order.firstIndex(of: id) else { return }
    order.remove(at: from)
    order.insert(id, at: min(index, order.count))
    dropped = order
    onReorder(id, index)
  }

  /// Where the dragged prompt would land: past every neighbour it has moved halfway over.
  private func target(of id: String, in rows: [QueuedView]) -> Int {
    guard let from = rows.firstIndex(where: { $0.id == id }) else { return 0 }
    var index = from
    var left = dragOffset
    if left > 0 {
      while index + 1 < rows.count {
        let next = (heights[rows[index + 1].id] ?? 40) + spacing
        guard left > next / 2 else { break }
        left -= next
        index += 1
      }
    } else {
      while index > 0 {
        let previous = (heights[rows[index - 1].id] ?? 40) + spacing
        guard -left > previous / 2 else { break }
        left += previous
        index -= 1
      }
    }
    return index
  }

  /// The dragged prompt follows the finger; the ones it passes step aside.
  private func offset(of id: String, in rows: [QueuedView]) -> CGFloat {
    guard let dragging, let from = rows.firstIndex(where: { $0.id == dragging }) else { return 0 }
    if id == dragging { return dragOffset }
    guard let index = rows.firstIndex(where: { $0.id == id }) else { return 0 }
    let to = target(of: dragging, in: rows)
    let gap = (heights[dragging] ?? 40) + spacing
    if from < index && index <= to { return -gap }
    if to <= index && index < from { return gap }
    return 0
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
