export function droppedFilePath(file: File): string | undefined {
  const bridge = window.harness
  if (!bridge || !('droppedFilePath' in bridge) || typeof bridge.droppedFilePath !== 'function')
    return undefined
  try {
    const value: unknown = bridge.droppedFilePath(file)
    return typeof value === 'string' && value.length > 0 && !value.includes('\0')
      ? value
      : undefined
  } catch {
    return undefined
  }
}
