export function windowThemeOptions(themeValue: unknown) {
  if (themeValue !== 'light' && themeValue !== 'dark' && themeValue !== 'codex') {
    throw new Error('Invalid window theme')
  }
  const theme = themeValue

  // The overlay colour must match the renderer's --bg-rail: the native caption
  // buttons sit on the title bar, and that bar carries the sidebar colour so
  // the two read as one element.
  if (theme === 'light') {
    return {
      backgroundColor: '#fdfdfd',
      titleBarOverlay: { color: '#fcfcfc', symbolColor: '#27272a', height: 34 },
    }
  }
  if (theme === 'codex') {
    return {
      backgroundColor: '#2d2d2b',
      titleBarOverlay: { color: '#353533', symbolColor: '#dededc', height: 34 },
    }
  }
  return {
    backgroundColor: '#202020',
    titleBarOverlay: { color: '#131313', symbolColor: '#ffffff', height: 34 },
  }
}

export function windowThemeSource(preference: unknown): 'system' | 'light' | 'dark' {
  if (
    preference !== 'system' &&
    preference !== 'light' &&
    preference !== 'dark' &&
    preference !== 'codex'
  ) {
    throw new Error('Invalid window theme preference')
  }
  return preference === 'codex' ? 'dark' : preference
}
