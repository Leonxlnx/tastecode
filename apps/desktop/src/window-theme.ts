export function windowThemeOptions(theme: unknown) {
  if (theme !== 'light' && theme !== 'dark') throw new Error('Invalid window theme')

  return theme === 'light'
    ? {
        backgroundColor: '#fdfdfd',
        titleBarOverlay: { color: '#fdfdfd', symbolColor: '#27272a', height: 34 },
      }
    : {
        backgroundColor: '#202020',
        titleBarOverlay: { color: '#202020', symbolColor: '#ffffff', height: 34 },
      }
}
