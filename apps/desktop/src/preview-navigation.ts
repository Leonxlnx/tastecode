export function allowsPreviewNavigation(previewUrl: string, navigationUrl: string): boolean {
  // A throw here would skip preventDefault in the navigation handler — deny.
  try {
    return new URL(navigationUrl).origin === new URL(previewUrl).origin
  } catch {
    return false
  }
}
