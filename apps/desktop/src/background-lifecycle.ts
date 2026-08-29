export function shouldHideWindowOnClose(
  platform: NodeJS.Platform,
  appIsQuitting: boolean,
  hasRecoverySurface: boolean,
): boolean {
  return platform !== 'darwin' && !appIsQuitting && hasRecoverySurface
}
