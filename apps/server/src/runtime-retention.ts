const GIBIBYTE = 1024 ** 3
const MEMORY_PER_IDLE_RUNTIME = 2 * GIBIBYTE
const MIN_IDLE_RUNTIMES = 4
const MAX_IDLE_RUNTIMES = 16
export const IDLE_THREAD_RUNTIME_MS = 5 * 60_000

/** Keep warm resume latency proportional to the machine without unbounded child processes. */
export function idleThreadRuntimeLimit(totalMemoryBytes: number): number {
  const hardwareLimit = Math.floor(Math.max(0, totalMemoryBytes) / MEMORY_PER_IDLE_RUNTIME)
  return Math.max(MIN_IDLE_RUNTIMES, Math.min(MAX_IDLE_RUNTIMES, hardwareLimit))
}
