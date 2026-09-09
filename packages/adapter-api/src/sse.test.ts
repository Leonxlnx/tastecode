import { describe, expect, it } from 'vitest'
import { MAX_PROTOCOL_FRAME_BYTES } from '@harness/proc'
import { httpError, serverSentEvents } from './sse.js'

function chunks(values: string[], onCancel = () => undefined): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      const value = values.shift()
      if (value === undefined) controller.close()
      else controller.enqueue(new TextEncoder().encode(value))
    },
    cancel: onCancel,
  })
}

describe('safe HTTP failures', () => {
  it('redacts a known credential before the display limit cuts it', async () => {
    const secret = 'canary-credential-never-log-me'
    const result = await httpError(
      'test',
      new Response('x'.repeat(390) + secret, { status: 401 }),
      [secret],
    )
    expect(result).toContain('[REDACTED]')
    expect(result).not.toContain('canary')
  })

  it('bounds endless error bodies and cancels after reading the limit', async () => {
    let pulls = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(4096).fill(120))
      },
      cancel() {
        cancelled = true
      },
    })
    const result = await httpError('test', new Response(stream, { status: 500 }))
    expect(result.length).toBeLessThan(500)
    expect(pulls).toBeLessThan(20)
    expect(cancelled).toBe(true)
  })

  it('bounds a stalled error body and keeps the public status', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
      { status: 503 },
    )
    await expect(httpError('test', response)).resolves.toContain('HTTP 503')
    expect(cancelled).toBe(true)
  })
})

describe('bounded API SSE', () => {
  it('reads CRLF split between chunks and multiline JSON', async () => {
    const events = await Array.fromAsync(
      serverSentEvents(chunks(['data: {"value":\r', '\ndata: 42}\r\n\r', '\n'])),
    )
    expect(events).toEqual([{ value: 42 }])
  })

  it('rejects a large unterminated event and cancels the response', async () => {
    let cancelled = false
    const body = chunks(['data: ' + 'x'.repeat(MAX_PROTOCOL_FRAME_BYTES), 'still alive'], () => {
      cancelled = true
    })
    await expect(Array.fromAsync(serverSentEvents(body))).rejects.toThrow('frame exceeds')
    expect(cancelled).toBe(true)
  })
})
