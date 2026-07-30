/**
 * Agents we know how to launch in ACP mode.
 *
 * This is a list of launch commands, not a list of integrations. Every entry
 * goes through the same adapter — that is the entire argument for supporting
 * ACP at all. Adding an agent is a row here.
 *
 * `verified` marks the ones whose frames were actually captured and read while
 * writing the adapter. The rest are launched on the strength of their own
 * documentation, so they are offered but labelled honestly rather than
 * presented as tested.
 */

export type AcpAgentSpec = {
  id: string
  name: string
  /** Executable, resolved on PATH. May be an npm shim on Windows. */
  command: string
  args: string[]
  /** True when frames from this agent were captured and read by us. */
  verified: boolean
  /** Shown when the binary is missing, so the user knows what to install. */
  install?: string
}

export const ACP_AGENTS: AcpAgentSpec[] = [
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp'],
    verified: true,
    install: 'npm i -g @google/gemini-cli',
  },
  {
    id: 'kimi',
    name: 'Kimi CLI',
    command: 'kimi',
    args: ['acp'],
    verified: true,
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    command: 'qwen',
    args: ['--experimental-acp'],
    // A Gemini CLI fork, so the same flag and very likely the same frames.
    // Not claimed as verified until someone has actually run it.
    verified: false,
    install: 'npm i -g @qwen-code/qwen-code',
  },
]

export function findAgentSpec(id: string): AcpAgentSpec | undefined {
  return ACP_AGENTS.find((agent) => agent.id === id)
}
