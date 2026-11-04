/**
 * The projects the user left open in the sidebar, so a reload or a restart
 * shows the rail as they left it instead of folding every project but the
 * active one. Read on each row's mount, not cached: a short list of paths.
 */
const KEY = 'harness.openProjects'

function read(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return new Set(
      Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

export function wasProjectOpen(path: string): boolean {
  return read().has(path)
}

export function rememberProjectOpen(path: string, open: boolean): void {
  const paths = read()
  if (paths.has(path) === open) return
  if (open) paths.add(path)
  else paths.delete(path)
  try {
    localStorage.setItem(KEY, JSON.stringify([...paths]))
  } catch {
    // Storage can be full or blocked; the rail then folds as before.
  }
}
