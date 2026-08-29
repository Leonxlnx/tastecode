export function shouldHideWindowOnClose(
  platform: NodeJS.Platform,
  appIsQuitting: boolean,
  hasRecoverySurface = true,
): boolean {
  return platform !== 'darwin' && !appIsQuitting && hasRecoverySurface
}
