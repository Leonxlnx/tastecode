// A stand-in for `claude` on its stream-json pipes, shaped after claude 2.1.310.
// It answers the control requests TasteCode sends and plays one turn per prompt:
// a streamed reply, a Bash call that asks for permission ("tool"), or a turn that
// runs until it is interrupted ("wait"). FAKE_CLAUDE_LOG receives its launch.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const sessionId =
  argValue('--session-id') ?? argValue('--resume') ?? '00000000-0000-4000-8000-000000000000'
// What claude 2.1.310 does for --resume of an id it has no transcript for.
if (argValue('--resume')?.startsWith('missing-')) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`)
}
const pendingAnswers = new Map()
let running

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    `${JSON.stringify({
      argv: process.argv.slice(2),
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
      nodeOptions: process.env.NODE_OPTIONS ?? null,
    })}\n`,
  )
}

function argValue(name) {
  const prefix = `${name}=`
  const arg = process.argv.find((value) => value.startsWith(prefix))
  return arg?.slice(prefix.length)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function respond(requestId, response) {
  send({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  })
}

function ask(request) {
  const requestId = `cli-${pendingAnswers.size + 1}-${Date.now()}`
  send({ type: 'control_request', request_id: requestId, request })
  return new Promise((resolve) => pendingAnswers.set(requestId, resolve))
}

function result(isError, errors = []) {
  send({
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    ...(isError ? { errors } : { result: 'done' }),
    stop_reason: 'end_turn',
    session_id: sessionId,
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {
      'claude-opus-5-5': {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.001,
        contextWindow: 200000,
        maxOutputTokens: 32000,
      },
    },
    permission_denials: [],
    uuid: crypto.randomUUID(),
  })
}

function assistant(id, content) {
  send({
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content,
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: crypto.randomUUID(),
  })
}

function stream(event) {
  send({
    type: 'stream_event',
    event,
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: crypto.randomUUID(),
  })
}

async function play(text) {
  send({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    tools: ['Bash'],
    mcp_servers: [],
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    slash_commands: ['review'],
    skills: [],
    apiKeySource: 'none',
    claude_code_version: '2.1.310',
    output_style: 'default',
    capabilities: [],
    uuid: crypto.randomUUID(),
  })
  if (text.includes('wait')) {
    await new Promise((resolve) => {
      running = resolve
    })
    result(true, ['[ede_diagnostic] stopped by the user'])
    return
  }
  if (text.includes('tool')) {
    const input = { command: 'echo hi', description: 'Say hi' }
    assistant('msg-tool', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input }])
    const answer = await ask({
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input,
      tool_use_id: 'toolu_1',
      permission_suggestions: [],
      title: 'Claude wants to run echo hi',
    })
    const allowed = answer.behavior === 'allow'
    send({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: allowed ? 'hi' : 'The user declined',
            is_error: !allowed,
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: crypto.randomUUID(),
      tool_use_result: { stdout: allowed ? 'hi' : '', stderr: '', interrupted: false },
    })
    assistant('msg-after', [{ type: 'text', text: allowed ? 'It printed hi.' : 'Not run.' }])
    result(false)
    return
  }
  stream({
    type: 'message_start',
    message: {
      id: 'msg-reply',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-opus-5-5',
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  })
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } })
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } })
  stream({ type: 'content_block_stop', index: 0 })
  assistant('msg-reply', [{ type: 'text', text: 'Hello there' }])
  result(false)
}

const answers = {
  initialize: () => ({
    commands: [{ name: 'review', description: 'Review the change', argumentHint: '' }],
    agents: [],
    output_style: 'default',
    available_output_styles: ['default'],
    models: [
      {
        value: 'default',
        resolvedModel: 'claude-opus-5-5',
        displayName: 'Default (recommended)',
        description: 'Opus 5.5',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5-5',
        displayName: 'Sonnet',
        description: 'Sonnet 5.5',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ],
    account: {},
    claude_code_version: '2.1.310',
  }),
  get_settings: () => ({ applied: { ultracode: false, ultracodeAvailable: false } }),
  mcp_status: () => ({
    mcpServers: [
      {
        name: 'fixture',
        status: 'connected',
        config: { type: 'stdio', command: 'fixture' },
        tools: [],
      },
    ],
  }),
  set_model: () => ({}),
  set_permission_mode: () => ({}),
  get_usage: () => ({
    session: {},
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 12, resets_at: '2026-10-25T20:00:00Z' } },
  }),
  interrupt: () => {
    const stop = running
    running = undefined
    setTimeout(() => stop?.(), 5)
    return { still_queued: [] }
  },
}

if (argValue('--resume')?.startsWith('missing-')) {
  result(true, [`No conversation found with session ID: ${sessionId}`])
  process.exit(1)
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const answer = answers[message.request.subtype]
    if (answer) respond(message.request_id, answer(message.request))
    else
      send({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: message.request_id,
          error: `unknown ${message.request.subtype}`,
        },
      })
  } else if (message.type === 'control_response') {
    const resolve = pendingAnswers.get(message.response.request_id)
    pendingAnswers.delete(message.response.request_id)
    resolve?.(message.response.response)
  } else if (message.type === 'user') {
    const content = message.message.content
    const text =
      typeof content === 'string' ? content : content.map((block) => block.text ?? '').join('')
    void play(text)
  }
}
