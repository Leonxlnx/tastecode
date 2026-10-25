import UIKit

/// A picture on black, fitted to the screen: pinch or double-tap to zoom,
/// and share it from the top.
final class ImageViewer: UINavigationController {
  init(image: UIImage) {
    super.init(rootViewController: ImageViewerController(image: image))
    modalPresentationStyle = .fullScreen
    overrideUserInterfaceStyle = .dark
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

private final class ImageViewerController: UIViewController, UIScrollViewDelegate {
  private let image: UIImage
  private let scroller = UIScrollView()
  private let picture = UIImageView()

  init(image: UIImage) {
    self.image = image
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    scroller.frame = view.bounds
    scroller.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    scroller.delegate = self
    scroller.minimumZoomScale = 1
    scroller.maximumZoomScale = 4
    scroller.showsVerticalScrollIndicator = false
    scroller.showsHorizontalScrollIndicator = false
    scroller.contentInsetAdjustmentBehavior = .never
    view.addSubview(scroller)
    picture.image = image
    picture.contentMode = .scaleAspectFit
    scroller.addSubview(picture)
    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
    doubleTap.numberOfTapsRequired = 2
    scroller.addGestureRecognizer(doubleTap)

    navigationItem.leftBarButtonItem = closeItem()
    let share = UIBarButtonItem(image: Tabler.image("share-2", size: 22), primaryAction: UIAction { [weak self] _ in
      self?.share()
    })
    share.accessibilityLabel = "Share"
    navigationItem.rightBarButtonItem = share
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    guard scroller.zoomScale == 1 else { return }
    picture.frame = scroller.bounds
    scroller.contentSize = scroller.bounds.size
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? { picture }

  @objc private func doubleTapped(_ tap: UITapGestureRecognizer) {
    if scroller.zoomScale > 1 {
      scroller.setZoomScale(1, animated: true)
    } else {
      let point = tap.location(in: picture)
      let size = CGSize(width: scroller.bounds.width / 2, height: scroller.bounds.height / 2)
      scroller.zoom(to: CGRect(origin: CGPoint(x: point.x - size.width / 2, y: point.y - size.height / 2), size: size), animated: true)
    }
  }

  private func share() {
    let sheet = UIActivityViewController(activityItems: [image], applicationActivities: nil)
    sheet.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItem
    present(sheet, animated: true)
  }
}
