import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

enum AttachmentPickerStyle {
  case glass
  case composer
}

struct AttachmentPickerButton: View {
  @Binding var attachments: [AttachmentDraft]
  var size: CGFloat = 40
  var style: AttachmentPickerStyle = .glass

  @State private var photoItem: PhotosPickerItem?
  @State private var importingFile = false
  @State private var errorMessage: String?

  var body: some View {
    Menu {
      PhotosPicker(selection: $photoItem, matching: .images) {
        LucideActionLabel(title: "Photo", icon: .image)
      }
      Button {
        importingFile = true
      } label: {
        LucideActionLabel(title: "File", icon: .file)
      }
    } label: {
      label
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Add attachment")
    .fileImporter(
      isPresented: $importingFile,
      allowedContentTypes: [.data, .content],
      allowsMultipleSelection: false
    ) { result in
      guard case .success(let urls) = result, let url = urls.first else {
        if case .failure(let error) = result { errorMessage = error.localizedDescription }
        return
      }
      Task { await loadFile(url) }
    }
    .onChange(of: photoItem) { _, item in
      guard let item else { return }
      Task { await loadPhoto(item) }
    }
    .alert(
      "Couldn’t add attachment",
      isPresented: Binding(
        get: { errorMessage != nil },
        set: { if !$0 { errorMessage = nil } }
      )
    ) {
      Button("OK", role: .cancel) { errorMessage = nil }
    } message: {
      Text(errorMessage ?? "")
    }
  }

  @ViewBuilder
  private var label: some View {
    switch style {
    case .glass:
      GlassIconLabel(icon: .plus, size: size, iconSize: size * 0.38)
        .frame(width: max(size, 44), height: max(size, 44))
        .contentShape(.circle)
    case .composer:
      ComposerIconLabel(icon: .plus)
    }
  }

  private func loadPhoto(_ item: PhotosPickerItem) async {
    do {
      guard let data = try await item.loadTransferable(type: Data.self) else {
        throw RPCFailure(message: "The selected photo has no readable data.", detail: nil)
      }
      guard data.count <= 25 * 1_024 * 1_024 else {
        throw RPCFailure(message: "The selected photo is larger than 25 MB.", detail: nil)
      }
      let type = item.supportedContentTypes.first ?? .jpeg
      let fileExtension = type.preferredFilenameExtension ?? "jpg"
      attachments.append(
        AttachmentDraft(
          name:
            "Photo-\(Date.now.formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false))).\(fileExtension)",
          mimeType: type.preferredMIMEType ?? "image/jpeg",
          data: data
        ))
      photoItem = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func loadFile(_ url: URL) async {
    do {
      let draft = try await Task.detached(priority: .userInitiated) {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        guard data.count <= 25 * 1_024 * 1_024 else {
          throw RPCFailure(message: "\(url.lastPathComponent) is larger than 25 MB.", detail: nil)
        }
        let values = try? url.resourceValues(forKeys: [.contentTypeKey])
        return AttachmentDraft(
          name: url.lastPathComponent,
          mimeType: values?.contentType?.preferredMIMEType ?? "application/octet-stream",
          data: data
        )
      }.value
      attachments.append(draft)
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

struct AttachmentStrip: View {
  @Binding var attachments: [AttachmentDraft]

  var body: some View {
    if !attachments.isEmpty {
      ScrollView(.horizontal) {
        HStack(spacing: 8) {
          ForEach(attachments) { attachment in
            Button {
              attachments.removeAll { $0.id == attachment.id }
            } label: {
              HStack(spacing: 7) {
                LucideIconView(attachment.mimeType.hasPrefix("image/") ? .image : .file, size: 14)
                Text(attachment.name)
                  .lineLimit(1)
                LucideIconView(.x, size: 10)
                  .foregroundStyle(HarnessColor.secondary)
              }
              .font(.system(size: 14, weight: .semibold))
              .padding(.horizontal, 12)
              .frame(height: 36)
              .harnessGlassCapsule()
            }
            .buttonStyle(.plain)
          }
        }
        .padding(.horizontal, 18)
      }
      .scrollIndicators(.hidden)
    }
  }
}
