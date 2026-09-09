import { ModelEndpointSchema, type Model } from '@harness/contracts'
import {
  jsonArray as array,
  type JsonObject,
  type JsonValue,
  jsonNumber as number,
  jsonObject as object,
  parseJsonValue,
  jsonString as string,
} from './json.js'
import type { ApiMessage, ApiStreamEvent, ApiTool, ApiToolCall, ApiTransport } from './runtime.js'
import { httpError, serverSentEvents } from './sse.js'

export type CompatibleProvider = 'openrouter' | 'kimi' | 'zai' | 'custom'

export const OPENAI_COMPATIBLE_PRESETS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    modelDiscovery: true,
    streamUsage: true,
    toolStream: false,
  },
  kimi: {
    baseUrl: 'https://api.moonshot.ai/v1',
    modelDiscovery: true,
    streamUsage: true,
    toolStream: false,
  },
  zai: {
    baseUrl: 'https://api.z.ai/api/paas/v4',
    modelDiscovery: false,
    streamUsage: false,
    toolStream: true,
  },
} as const

export type OpenAiCompatibleOptions = {
  apiKey: string
  provider: CompatibleProvider
  baseUrl?: string
}

export function createOpenAiCompatibleTransport(options: OpenAiCompatibleOptions): ApiTransport {
  const config = resolve(options)
  const endpoint = endpointFor(config.baseUrl, 'chat/completions')
  const apiKey = requiredKey(options.apiKey)

  return async function* ({ model, messages, tools, signal }) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: messages.map(toMessage),
        tools: tools.map(toTool),
        stream: true,
        ...(config.streamUsage ? { stream_options: { include_usage: true } } : {}),
        ...(config.toolStream ? { tool_stream: true } : {}),
      }),
      signal,
    })
    if (!response.ok) throw new Error(await httpError('OpenAI-compatible', response, [apiKey]))
    if (!response.body) throw new Error('OpenAI-compatible response had no stream')

    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    let finish: 'stop' | 'tool_calls' | undefined
    let truncated = false
    for await (const event of serverSentEvents(response.body)) {
      if (event.error) throw new Error('OpenAI-compatible response failed')
      const choice = object(array(event.choices)[0])
      const delta = object(choice.delta)
      const reasoning = string(delta.reasoning_content) || string(delta.reasoning)
      if (reasoning) yield { type: 'reasoning', delta: reasoning } satisfies ApiStreamEvent
      const content = string(delta.content)
      if (content) yield { type: 'text', delta: content } satisfies ApiStreamEvent
      for (const value of array(delta.tool_calls)) {
        const fragment = object(value)
        const index = number(fragment.index)
        const existing = calls.get(index) ?? { id: '', name: '', arguments: '' }
        const fn = object(fragment.function)
        existing.id ||= string(fragment.id)
        existing.name += string(fn.name)
        existing.arguments += string(fn.arguments)
        calls.set(index, existing)
      }
      if (event.usage) {
        const usage = object(event.usage)
        yield {
          type: 'usage',
          usage: {
            inputTokens: number(usage.prompt_tokens),
            cachedInputTokens: number(object(usage.prompt_tokens_details).cached_tokens),
            outputTokens: number(usage.completion_tokens),
            reasoningTokens: number(object(usage.completion_tokens_details).reasoning_tokens),
            totalTokens: number(usage.total_tokens),
            inputIncludesCached: true,
          },
        } satisfies ApiStreamEvent
      }
      const reason = string(choice.finish_reason)
      if (reason === 'tool_calls') finish = 'tool_calls'
      // 'length' is a truncated answer, not a failure worth discarding it for.
      else if (reason === 'stop' || reason === 'length') {
        finish = 'stop'
        if (reason === 'length') truncated = true
      } else if (reason) {
        throw new Error(`OpenAI-compatible response did not complete (${reason})`)
      }
    }

    // A cut at max_tokens can land mid tool-call. Executing a tool with
    // truncated JSON arguments is worse than surfacing the truncation — drop
    // the incomplete calls and let 'stop' report what happened.
    if (truncated) calls.clear()

    for (const call of calls.values()) {
      if (!call.id || !call.name)
        throw new Error('OpenAI-compatible provider returned an invalid tool call')
      let input: JsonValue
      try {
        input = parseJsonValue(call.arguments)
      } catch {
        throw new Error('OpenAI-compatible provider returned invalid tool arguments')
      }
      yield {
        type: 'tool_call',
        call: { id: call.id, name: call.name, input },
      } satisfies ApiStreamEvent
    }
    if (!finish) throw new Error('OpenAI-compatible response ended without a finish reason')
    // Providers sometimes report 'stop' while still emitting tool calls;
    // honoring the reported reason would orphan those calls.
    if (calls.size > 0) finish = 'tool_calls'
    yield { type: 'finish', reason: finish } satisfies ApiStreamEvent
  }
}

export async function listOpenAiCompatibleModels(
  options: OpenAiCompatibleOptions & { defaultModel?: string },
): Promise<Model[]> {
  const config = resolve(options)
  if (!config.modelDiscovery) return []
  const apiKey = requiredKey(options.apiKey)
  const response = await fetch(endpointFor(config.baseUrl, 'models'), {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) {
    throw new Error(`OpenAI-compatible model listing failed with HTTP ${response.status}`)
  }
  const body = object(parseJsonValue(await response.text()))
  return array(body.data)
    .map(object)
    .map((entry) => string(entry.id))
    .filter(Boolean)
    .sort()
    .map((id) => ({
      id,
      displayName: id,
      isDefault: id === options.defaultModel,
      reasoningEfforts: [],
      serviceTiers: [],
    }))
}

interface CompatibleConfig {
  baseUrl: string
  modelDiscovery: boolean
  streamUsage: boolean
  toolStream: boolean
}

function resolve(options: OpenAiCompatibleOptions): CompatibleConfig {
  if (options.provider === 'custom') {
    if (!options.baseUrl) throw new Error('A base URL is required for a custom endpoint')
    return { baseUrl: options.baseUrl, modelDiscovery: true, streamUsage: true, toolStream: false }
  }
  return {
    ...OPENAI_COMPATIBLE_PRESETS[options.provider],
    baseUrl: options.baseUrl ?? OPENAI_COMPATIBLE_PRESETS[options.provider].baseUrl,
  }
}

function toMessage(message: ApiMessage): JsonObject {
  if (message.role === 'user') return { role: 'user', content: message.content }
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
  return {
    role: 'assistant',
    content: message.content || null,
    ...(message.toolCalls.length
      ? {
          tool_calls: message.toolCalls.map(toToolCall),
        }
      : {}),
  }
}

function toToolCall(call: ApiToolCall): JsonObject {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  }
}

function toTool(tool: ApiTool): JsonObject {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

function endpointFor(baseUrl: string, path: string): URL {
  const base = ModelEndpointSchema.parse(baseUrl)
  return new URL(path, base.endsWith('/') ? base : `${base}/`)
}

function requiredKey(value: string): string {
  if (!value.trim()) throw new Error('An API key is required')
  return value
}
