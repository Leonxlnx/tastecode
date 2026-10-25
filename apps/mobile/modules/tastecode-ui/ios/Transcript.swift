import SwiftUI
import UIKit

// SwiftUI pieces other screens share. The transcript itself is UIKit: see
// TranscriptController.

/// What you sent, while a new chat starts: right-aligned on a quiet fill.
struct UserMessage: View {
  let text: String

  var body: some View {
    VStack(alignment: .trailing, spacing: 6) {
      if !text.isEmpty {
        Text(text)
          .font(.body)
          .lineSpacing(2)
          .textSelection(.enabled)
          .padding(.horizontal, 15)
          .padding(.vertical, 10)
          .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 20, style: .continuous))
      }
    }
    .padding(.leading, 48)
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

/// "+12 −3", green and red: the one place a change's size is coloured.
struct LineCounts: View {
  let added: Int
  let removed: Int

  var body: some View {
    HStack(spacing: 4) {
      if added > 0 || removed == 0 {
        Text("+\(added)").foregroundStyle(.green)
      }
      if removed > 0 {
        Text("−\(removed)").foregroundStyle(.red)
      }
    }
    .monospacedDigit()
  }
}

struct WorkingLine: View {
  let text: String

  var body: some View {
    HStack(spacing: 8) {
      ProgressView()
        .controlSize(.mini)
      Text(text)
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
  }
}

/// A picture on black, fitted to the screen, pinch to zoom.
struct ImageViewer: View {
  @Environment(\.dismiss) private var dismiss
  let image: UIImage
  @State private var scale: CGFloat = 1
  @GestureState private var pinch: CGFloat = 1

  var body: some View {
    NavigationStack {
      Image(uiImage: image)
        .resizable()
        .scaledToFit()
        .scaleEffect(max(1, scale * pinch))
        .gesture(
          MagnifyGesture()
            .updating($pinch) { value, state, _ in state = value.magnification }
            .onEnded { value in
              withAnimation(.smooth) { scale = min(4, max(1, scale * value.magnification)) }
            }
        )
        .onTapGesture(count: 2) {
          withAnimation(.smooth) { scale = scale > 1 ? 1 : 2 }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            CloseButton { dismiss() }
          }
          ToolbarItem(placement: .topBarTrailing) {
            ShareLink(item: Image(uiImage: image), preview: SharePreview("Picture", image: Image(uiImage: image)))
          }
        }
        .toolbarColorScheme(.dark, for: .navigationBar)
    }
  }
}
