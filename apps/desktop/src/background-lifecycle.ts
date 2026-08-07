export function shouldHideWindowOnClose(
  platform: NodeJS.Platform,
  appIsQuitting: boolean,
): boolean {
  return platform !== 'darwin' && !appIsQuitting
}
