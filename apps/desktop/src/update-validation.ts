export class InvalidUpdateError extends Error {}

/** Tool failures alone say nothing about the already verified source bytes. */
export function isInvalidUpdate(error: unknown): boolean {
  if (error instanceof InvalidUpdateError) return true
  if (!(error instanceof Error)) return false
  if ('code' in error && error.code === 'ERR_UPDATER_INVALID_SIGNATURE') return true
  return /(?:signature mismatch|code signature .*did not pass validation)/i.test(error.message)
}

export function invalidDmgToolOutput(tool: 'hdiutil' | 'codesign', error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const output =
    'stderr' in error && typeof error.stderr === 'string' ? error.stderr : error.message
  return tool === 'hdiutil'
    ? /image not recognized|no mountable file systems|checksum (?:is )?(?:invalid|mismatch)/i.test(
        output,
      )
    : /code object is not signed at all|code or signature (?:have been )?modified|a sealed resource is missing or invalid|invalid signature/i.test(
        output,
      )
}
