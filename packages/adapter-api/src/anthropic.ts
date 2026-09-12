import { ModelEndpointSchema, type Model } from '@harness/contracts'
import {
  type JsonObject,
  jsonNumber as number,
  jsonObject as object,
  parseJsonValue,
  jsonString as string,
} from './json.js'
import type { ApiMessage, ApiStreamEvent, ApiTool, ApiTransport } from './runtime.js'
import { httpError, serverSentEvents } from './sse.js'

export type AnthropicOptions = {
  apiKey: string
  baseUrl?: string
  maxTokens?: number
}

export function createAnthropicMessagesTransport(options: AnthropicOptions): ApiTransport {
  const endpoint = endpointFor(options.baseUrl, 'messages')
  const apiKey = requiredKey(options.apiKey)
  const maxTokens = options.maxTokens ?? 8192
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('maxTokens must be positive')

  return async function* ({ model, messages, tools, signal }) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: headers(apiKey, true),
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: toMessages(messages),
        tools: tools.map(toTool),
        stream: true,
      }),
      signal,
    })
    if (!response.ok) throw new Error(await httpError('Anthropic', response, [apiKey]))
    if (!response.body) throw new Error('Anthropic response had no stream')

    const blocks = new Map<number, JsonObject>()
    const json = new Map<number, string>()
    let inputTokens = 0
    let cachedInputTokens = 0
    let outputTokens = 0
    let stopReason = ''

    for await (const event of serverSentEvents(response.body)) {
      const type = string(event.type)
      if (type === 'message_start') {
        const usage = object(object(event.message).usage)
        inputTokens = number(usage.input_tokens)
        cachedInputTokens = number(usage.cache_read_input_tokens)
      } else if (type === 'content_block_start') {
        blocks.set(number(event.index), structuredClone(object(event.content_block)))
      } else if (type === 'content_block_delta') {
        const index = number(event.index)
        const delta = object(event.delta)
        const block = blocks.get(index) ?? {}
        if (delta.type === 'text_delta') {
          block.text = string(block.text) + string(delta.text)
          yield { type: 'text', delta: string(delta.text) } satisfies ApiStreamEvent
        } else if (delta.type === 'thinking_delta') {
          block.thinking = string(block.thinking) + string(delta.thinking)
          yield { type: 'reasoning', delta: string(delta.thinking) } satisfies ApiStreamEvent
        } else if (delta.type === 'signature_delta') {
          block.signature = string(block.signature) + string(delta.signature)
        } else if (delta.type === 'input_json_delta') {
          json.set(index, (json.get(index) ?? '') + string(delta.partial_json))
        }
        blocks.set(index, block)
      } else if (type === 'content_block_stop') {
        const index = number(event.index)
        const block = blocks.get(index) ?? {}
        if (block.type === 'tool_use') {
          const input = json.get(index)
          block.input = input ? parseJsonValue(input) : (block.input ?? {})
          yield {
            type: 'tool_call',
            call: {
              id: string(block.id),
              name: string(block.name),
              input: block.input,
            },
          } satisfies ApiStreamEvent
        }
      } else if (type === 'message_delta') {
        stopReason = string(object(event.delta).stop_reason)
        outputTokens = number(object(event.usage).output_tokens)
      } else if (type === 'message_stop') {
        if (
          stopReason !== 'end_turn' &&
          stopReason !== 'stop_sequence' &&
          stopReason !== 'tool_use' &&
          // Hitting the output cap truncates the answer; throwing here threw
          // the whole streamed text away with it.
          stopReason !== 'max_tokens'
        ) {
          throw new Error(`Anthropic response stopped before completion (${stopReason})`)
        }
        yield {
          type: 'state',
          value: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block),
        } satisfies ApiStreamEvent
        yield {
          type: 'usage',
          usage: {
            inputTokens,
            cachedInputTokens,
            outputTokens,
            reasoningTokens: 0,
            totalTokens: inputTokens + outputTokens,
            inputIncludesCached: false,
          },
        } satisfies ApiStreamEvent
        yield {
          type: 'finish',
          reason: stopReason === 'tool_use' ? 'tool_calls' : 'stop',
        } satisfies ApiStreamEvent
      } else if (type === 'error') {
        throw new Error('Anthropic response failed')
      }
    }
  }
}

export async function listAnthropicModels(
  options: AnthropicOptions & { defaultModel?: string },
): Promise<Model[]> {
  const apiKey = requiredKey(options.apiKey)
  const endpoint = endpointFor(options.baseUrl, 'models')
  endpoint.searchParams.set('limit', '1000')
  const models: Model[] = []
  let afterId = ''
  while (true) {
    const response = await fetch(endpoint, { headers: headers(apiKey) })
    if (!response.ok) throw new Error(`Anthropic model listing failed with HTTP ${response.status}`)
    const body = object(parseJsonValue(await response.text()))
    if (Array.isArray(body.data)) {
      for (const entry of body.data.map(object)) {
        const id = string(entry.id)
        if (id) {
          models.push({
            id,
            displayName: string(entry.display_name) || id,
            isDefault: id === options.defaultModel,
            reasoningEfforts: [],
            serviceTiers: [],
          })
        }
      }
    }
    const lastId = string(body.last_id)
    if (!body.has_more) return models
    if (!lastId || lastId === afterId) throw new Error('Anthropic model pagination did not advance')
    afterId = lastId
    endpoint.searchParams.set('after_id', lastId)
  }
}

function toMessages(messages: readonly ApiMessage[]): JsonObject[] {
  const result: JsonObject[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === 'user') {
      result.push({ role: 'user', content: message.content })
    } else if (message.role === 'assistant') {
      result.push({
        role: 'assistant',
        content: Array.isArray(message.transportState)
          ? message.transportState
          : [
              ...(message.content ? [{ type: 'text', text: message.content }] : []),
              ...message.toolCalls.map((call) => ({
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: call.input,
              })),
            ],
      })
    } else {
      const content: JsonObject[] = []
      for (; index < messages.length && messages[index]?.role === 'tool'; index++) {
        const tool = messages[index]!
        if (tool.role !== 'tool') break
        content.push({
          type: 'tool_result',
          tool_use_id: tool.toolCallId,
          content: tool.content,
          is_error: tool.isError,
        })
      }
      index--
      result.push({ role: 'user', content })
    }
  }
  return result
}

function toTool(tool: ApiTool): JsonObject {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema }
}

function headers(apiKey: string, json = false): Headers {
  const result = new Headers({
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  })
  if (json) result.set('content-type', 'application/json')
  return result
}

function endpointFor(baseUrl = 'https://api.anthropic.com/v1', path: string): URL {
  const base = ModelEndpointSchema.parse(baseUrl)
  return new URL(path, base.endsWith('/') ? base : `${base}/`)
}

function requiredKey(value: string): string {
  if (!value.trim()) throw new Error('Anthropic API key is required')
  return value
}
