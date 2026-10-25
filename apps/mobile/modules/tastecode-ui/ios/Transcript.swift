import SwiftUI
import UIKit

// SwiftUI pieces other screens share. The transcript itself is UIKit: see
// TranscriptController.

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
