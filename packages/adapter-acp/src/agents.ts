import type { Model } from '@harness/contracts'
import { isInstalled, spawnCli } from '@harness/proc'

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
  /** Wire version captured while verifying this agent. */
  supportedVersion?: string
  /** Shown when the binary is missing, so the user knows what to install. */
  install?: string
  /** CLI flag used to select a model before the ACP handshake. */
  modelArg?: string
  /** ACP config option used to select a model after creating a session. */
  modelConfigId?: string
}

export const ACP_AGENTS: AcpAgentSpec[] = [
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp'],
    verified: true,
    modelArg: '--model',
    install: 'npm i -g @google/gemini-cli',
  },
  {
    id: 'kimi',
    name: 'Kimi CLI',
    command: 'kimi',
    args: ['acp'],
    verified: true,
    supportedVersion: '0.29',
    modelConfigId: 'model',
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    command: 'qwen',
    args: ['--experimental-acp'],
    // A Gemini CLI fork, so the same flag and very likely the same frames.
    // Not claimed as verified until someone has actually run it.
    verified: false,
    modelArg: '--model',
    install: 'npm i -g @qwen-code/qwen-code',
  },
]

export function findAgentSpec(id: string): AcpAgentSpec | undefined {
  return ACP_AGENTS.find((agent) => agent.id === id)
}

export async function detectAgents(): Promise<Array<AcpAgentSpec & { installed: boolean }>> {
  return Promise.all(
    ACP_AGENTS.map(async (agent) => ({ ...agent, installed: await isInstalled(agent.command) })),
  )
}

/** Model choices exposed by the agent's own stable surface. */
export async function discoverAgentModels(agentId: string): Promise<Model[]> {
  if (agentId === 'gemini') {
    return [
      model('auto', 'Auto (Gemini)', 'Let Gemini CLI route each task', true),
      model('pro', 'Pro', 'Prefer Gemini Pro models'),
      model('flash', 'Flash', 'Prefer Gemini Flash models'),
      model('flash-lite', 'Flash Lite', 'Prefer Gemini Flash Lite models'),
    ]
  }
  if (agentId !== 'kimi') return []
  return parseKimiModels(await captureCli('kimi', ['provider', 'list', '--json']))
}

function model(id: string, displayName: string, description: string, isDefault = false): Model {
  return { id, displayName, description, isDefault, reasoningEfforts: [], serviceTiers: [] }
}

export function parseKimiModels(output: string): Model[] {
  const parsed = JSON.parse(output) as { models?: Record<string, unknown> }
  const entries = Object.entries(parsed.models ?? {})
  return entries.map(([id, value], index) => {
    const details = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    const efforts = Array.isArray(details.supportEfforts)
      ? details.supportEfforts.filter((effort): effort is string => typeof effort === 'string')
      : []
    return {
      id,
      displayName: typeof details.displayName === 'string' ? details.displayName : id,
      isDefault: index === 0,
      reasoningEfforts: efforts,
      ...(typeof details.defaultEffort === 'string'
        ? { defaultReasoningEffort: details.defaultEffort }
        : {}),
      serviceTiers: [],
    }
  })
}

function captureCli(command: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args)
    let output = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : resolve(output)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`${command} model discovery timed out`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (output += chunk))
    child.on('error', (error) => finish(error))
    child.on('exit', (code) =>
      finish(code === 0 ? undefined : new Error(`${command} model discovery failed`)),
    )
  })
}
