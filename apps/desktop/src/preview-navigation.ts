export function allowsPreviewNavigation(previewUrl: string, navigationUrl: string): boolean {
  return new URL(navigationUrl).origin === new URL(previewUrl).origin
}
