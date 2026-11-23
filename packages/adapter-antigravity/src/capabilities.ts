import type { Capabilities } from '@harness/contracts'

export const ANTIGRAVITY_CAPABILITIES: Capabilities = {
  // agy acp 1.5.14: session/cancel, session/load, live permission requests,
  // thought chunks, and native image blocks (promptCapabilities.image: true).
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  images: true,
  imageFiles: true,
}
