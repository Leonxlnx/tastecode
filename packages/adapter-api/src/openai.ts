import { ModelEndpointSchema, type Model } from '@harness/contracts'
import {
  type JsonObject,
  jsonNumber as number,
  jsonObject as object,
  parseJsonValue,
  jsonString as string,
} from './json.js'
import type { ApiMessage, ApiStreamEvent, ApiTool, ApiToolCall, ApiTransport } from './runtime.js'
import { httpError, serverSentEvents } from './sse.js'

export type OpenAiOptions = {
  apiKey: string
  baseUrl?: string
}

export function createOpenAiResponsesTransport(options: OpenAiOptions): ApiTransport {
  const endpoint = endpointFor(options.baseUrl, 'responses')
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
        input: toInput(messages),
        tools: tools.map(toTool),
        stream: true,
        store: false,
        include: ['reasoning.encrypted_content'],
      }),
      signal,
    })
    if (!response.ok) throw new Error(await httpError('OpenAI', response, [apiKey]))
    if (!response.body) throw new Error('OpenAI response had no stream')

    const calls = new Map<string, { callId: string; name: string }>()
    let sawTool = false
    for await (const event of serverSentEvents(response.body)) {
      const type = string(event.type)
      if (type === 'response.output_text.delta') {
        yield { type: 'text', delta: string(event.delta) } satisfies ApiStreamEvent
      } else if (type === 'response.refusal.delta') {
        yield { type: 'text', delta: string(event.delta) } satisfies ApiStreamEvent
      } else if (
        type === 'response.reasoning_summary_text.delta' ||
        type === 'response.reasoning_text.delta'
      ) {
        yield { type: 'reasoning', delta: string(event.delta) } satisfies ApiStreamEvent
      } else if (type === 'response.output_item.added') {
        const item = object(event.item)
        if (item.type === 'function_call') {
          calls.set(string(item.id), {
            callId: string(item.call_id),
            name: string(item.name),
          })
        }
      } else if (type === 'response.function_call_arguments.done') {
        const call = calls.get(string(event.item_id))
        const callId = call?.callId || string(event.call_id)
        const name = call?.name || string(event.name)
        if (!callId || !name) throw new Error('OpenAI returned an invalid function call')
        sawTool = true
        yield {
          type: 'tool_call',
          call: {
            id: callId,
            name,
            input: parseJsonValue(string(event.arguments)),
          },
        } satisfies ApiStreamEvent
      } else if (type === 'response.completed') {
        const completed = object(event.response)
        yield { type: 'state', value: completed.output ?? [] } satisfies ApiStreamEvent
        if (completed.usage) {
          const usage = object(completed.usage)
          yield {
            type: 'usage',
            usage: {
              inputTokens: number(usage.input_tokens),
              cachedInputTokens: number(object(usage.input_tokens_details).cached_tokens),
              outputTokens: number(usage.output_tokens),
              reasoningTokens: number(object(usage.output_tokens_details).reasoning_tokens),
              totalTokens: number(usage.total_tokens),
              inputIncludesCached: true,
            },
          } satisfies ApiStreamEvent
        }
        yield {
          type: 'finish',
          reason: sawTool ? 'tool_calls' : 'stop',
        } satisfies ApiStreamEvent
      } else if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
        throw new Error('OpenAI response failed')
      }
    }
  }
}

export async function listOpenAiModels(
  options: OpenAiOptions & { defaultModel?: string },
): Promise<Model[]> {
  const apiKey = requiredKey(options.apiKey)
  const response = await fetch(endpointFor(options.baseUrl, 'models'), {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) throw new Error(`OpenAI model listing failed with HTTP ${response.status}`)
  const body = object(parseJsonValue(await response.text()))
  return Array.isArray(body.data)
    ? body.data
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
    : []
}

function toInput(messages: readonly ApiMessage[]): unknown[] {
  return messages.flatMap((message) => {
    if (message.role === 'user') return [{ role: 'user', content: message.content }]
    if (message.role === 'tool') {
      return [
        {
          type: 'function_call_output',
          call_id: message.toolCallId,
          output: message.content,
        },
      ]
    }
    if (Array.isArray(message.transportState)) return message.transportState
    return [
      ...(message.content ? [{ role: 'assistant', content: message.content }] : []),
      ...message.toolCalls.map(toFunctionCall),
    ]
  })
}

function toFunctionCall(call: ApiToolCall): JsonObject {
  return {
    type: 'function_call',
    call_id: call.id,
    name: call.name,
    arguments: JSON.stringify(call.input),
  }
}

function toTool(tool: ApiTool): JsonObject {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }
}

function endpointFor(baseUrl = 'https://api.openai.com/v1', path: string): URL {
  const base = ModelEndpointSchema.parse(baseUrl)
  return new URL(path, base.endsWith('/') ? base : `${base}/`)
}

function requiredKey(value: string): string {
  if (!value.trim()) throw new Error('OpenAI API key is required')
  return value
}
