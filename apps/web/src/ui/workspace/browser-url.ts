export function browserUrl(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '[::1]')) {
      url.hostname = '127.0.0.1'
    }
    return url.href
  } catch {
    return undefined
  }
}
