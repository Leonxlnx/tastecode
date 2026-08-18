export function errorMessage(cause: unknown, fallback = 'An unexpected error occurred.'): string {
  if (cause instanceof Error) return cause.message.trim() || fallback
  return String(cause).trim() || fallback
}
