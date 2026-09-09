// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { flushSync } from 'react-dom'
import { afterAll, bench, describe, vi } from 'vitest'
import type { ReactNode } from 'react'

const MESSAGE_COUNT = 500
const READY_RESULT = { tokens: [[{ content: 'const value = 1' }]] }
const highlighter = vi.hoisted(() => ({
  callbacks: new Set<(result: typeof READY_RESULT) => void>(),
  listeners: new Set<() => void>(),
  streamdownRender: vi.fn(),
}))

vi.mock('./highlighter.js', () => ({
  onHighlighterChange(listener: () => void) {
    highlighter.listeners.add(listener)
    return () => highlighter.listeners.delete(listener)
  },
  shikiPlugin: {
    highlight(_options: unknown, callback?: (result: typeof READY_RESULT) => void) {
      if (callback) highlighter.callbacks.add(callback)
      return READY_RESULT
    },
  },
}))

vi.mock('streamdown', async () => {
  const { useEffect, useState } = await import('react')
  return {
    Streamdown(props: {
      children: ReactNode
      plugins: {
        code: {
          highlight: (options: unknown, callback?: (result: typeof READY_RESULT) => void) => unknown
        }
      }
    }) {
      const [, setHighlightVersion] = useState(0)
      highlighter.streamdownRender()
      useEffect(() => {
        const text = String(props.children)
        if (!text.includes('```')) return
        props.plugins.code.highlight({ code: text, language: 'typescript' }, () => {
          setHighlightVersion((version) => version + 1)
        })
      }, [props.children, props.plugins])
      return <div>{props.children}</div>
    },
  }
})

import { CompletedMarkdown } from './CompletedMarkdown.js'

const messages = Array.from({ length: MESSAGE_COUNT }, (_, index) =>
  index === 0 ? '```ts\nconst value = 1\n```' : `**Completed reply ${index}**`,
)
const view = render(
  <>
    {messages.map((text) => (
      <CompletedMarkdown key={text} text={text} />
    ))}
  </>,
)

if (highlighter.listeners.size !== 0 || highlighter.callbacks.size !== 1) {
  throw new Error('benchmark did not mount the expected highlighter work')
}

highlighter.streamdownRender.mockClear()

afterAll(() => view.unmount())

describe('completed Markdown highlighter readiness', () => {
  bench(
    'processes one code highlight across 500 visible replies',
    () => {
      const before = highlighter.streamdownRender.mock.calls.length
      flushSync(() => {
        for (const listener of highlighter.listeners) listener()
        for (const callback of highlighter.callbacks) callback(READY_RESULT)
      })
      const renders = highlighter.streamdownRender.mock.calls.length - before
      if (renders !== 1) throw new Error(`rendered ${renders} replies`)
    },
    { time: 1_200, warmupTime: 300 },
  )
})
