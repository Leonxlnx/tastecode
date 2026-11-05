const GIBIBYTE = 1024 ** 3
// One warm agent per 8 GiB: an idle Claude Code process holds about 0.5-1 GB of private memory and a Codex
// app-server about 140 MB (measured on a 64 GB laptop, 2026-11-05), so the old 2 GiB step let a large machine
// keep 16 of them, up to 8-13 GB, after a busy hour.
const MEMORY_PER_IDLE_RUNTIME = 8 * GIBIBYTE
const MIN_IDLE_RUNTIMES = 2
const MAX_IDLE_RUNTIMES = 6
/** An idle agent is stopped after two minutes; the chat resumes it on its next turn. */
export const IDLE_THREAD_RUNTIME_MS = 2 * 60_000

/** Keep warm resume latency proportional to the machine without unbounded child processes. */
export function idleThreadRuntimeLimit(totalMemoryBytes: number): number {
  const hardwareLimit = Math.floor(Math.max(0, totalMemoryBytes) / MEMORY_PER_IDLE_RUNTIME)
  return Math.max(MIN_IDLE_RUNTIMES, Math.min(MAX_IDLE_RUNTIMES, hardwareLimit))
}
