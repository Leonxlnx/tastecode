export function windowThemeOptions(theme: unknown) {
  if (theme !== 'light' && theme !== 'dark') throw new Error('Invalid window theme')

  // The overlay colour must match the renderer's --bg-rail: the native caption
  // buttons sit on the title bar, and that bar carries the sidebar colour so
  // the two read as one element.
  return theme === 'light'
    ? {
        backgroundColor: '#fdfdfd',
        titleBarOverlay: { color: '#fcfcfc', symbolColor: '#27272a', height: 34 },
      }
    : {
        backgroundColor: '#202020',
        titleBarOverlay: { color: '#131313', symbolColor: '#ffffff', height: 34 },
      }
}

export function windowThemeSource(preference: unknown): 'system' | 'light' | 'dark' {
  if (preference === 'system' || preference === 'light' || preference === 'dark') {
    return preference
  }
  throw new Error('Invalid window theme preference')
}
