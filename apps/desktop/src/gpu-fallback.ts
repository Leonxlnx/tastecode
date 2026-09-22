import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

export const GPU_FALLBACK_FILE = 'gpu-fallback.json'
export const GPU_CRASH_WINDOW_MS = 60_000
export const GPU_CRASH_LIMIT = 2

// child-process-gone reasons that mean the GPU process died on its own.
// 'clean-exit' and 'killed' happen during normal teardown and must not count.
const GPU_FAILURE_REASONS = new Set([
  'abnormal-exit',
  'crashed',
  'integrity-failure',
  'launch-failed',
  'oom',
])

export function isGpuProcessFailure(details: { type?: string; reason?: string }): boolean {
  return details.type === 'GPU' && GPU_FAILURE_REASONS.has(details.reason ?? '')
}

/** True once `limit` GPU failures landed inside the trailing `windowMs`. */
export function shouldFallbackToSoftware(
  failures: readonly number[],
  now: number,
  windowMs = GPU_CRASH_WINDOW_MS,
  limit = GPU_CRASH_LIMIT,
): boolean {
  return failures.filter((at) => now - at <= windowMs).length >= limit
}

export function gpuFallbackFlagPath(userData: string): string {
  return path.join(userData, GPU_FALLBACK_FILE)
}

/** Synchronous read: this decides before `app.whenReady()` whether the GPU is used. */
export function gpuFallbackRequested(userData: string): boolean {
  const flag = gpuFallbackFlagPath(userData)
  if (!existsSync(flag)) return false
  try {
    const parsed: unknown = JSON.parse(readFileSync(flag, 'utf8'))
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { softwareRendering?: unknown }).softwareRendering === true
    )
  } catch {
    return false
  }
}

export async function writeGpuFallbackFlag(userData: string): Promise<void> {
  await writeFile(
    gpuFallbackFlagPath(userData),
    JSON.stringify({ softwareRendering: true }, null, 2) + '\n',
    'utf8',
  )
}
