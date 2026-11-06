// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TestTransport } from '../test-transport.js'
import { ProviderExecutablePath, useProviderExecutablePaths } from './ProviderExecutablePath.js'

afterEach(cleanup)

function Field(props: { transport: TestTransport; onSaved?: () => void }) {
  const { paths, readError, setPaths } = useProviderExecutablePaths(props.transport)
  return (
    <ProviderExecutablePath
      source="codex"
      name="Codex"
      paths={paths}
      readError={readError}
      transport={props.transport}
      onSaved={(next) => {
        setPaths(next)
        props.onSaved?.()
      }}
    />
  )
}

it('marks a custom path while closed, then saves, reports invalid paths, and resets', async () => {
  const saved = vi.fn()
  const transport = new TestTransport((method, params) => {
    if (method === 'providers.executablePaths') return { codex: '/old/codex' }
    if (method === 'providers.updateExecutablePath') {
      const { path } = params as { path: string }
      if (path === '/missing') throw new Error('Executable does not exist')
      return path ? { codex: path } : {}
    }
    throw new Error('Unexpected request')
  })
  render(<Field transport={transport} onSaved={saved} />)
  expect((await screen.findByText('Executable path · Custom')).tagName).toBe('SUMMARY')
  expect(screen.queryByLabelText('Codex executable path')).toBeNull()
  fireEvent.click(screen.getByText('Executable path · Custom'))
  const input = screen.getByLabelText('Codex executable path')
  expect(input).toHaveProperty('value', '/old/codex')
  fireEvent.change(input, { target: { value: '/missing' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Executable does not exist')
  expect(saved).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(transport.requests.at(-1)).toEqual({
    method: 'providers.updateExecutablePath',
    params: { source: 'codex', path: '' },
  })
  await waitFor(() => expect(screen.getByText('Executable path').tagName).toBe('SUMMARY'))
})

it('keeps a failed read out of the page until the field is opened', async () => {
  const transport = new TestTransport(() => {
    throw new Error('Paths are unavailable')
  })
  render(<Field transport={transport} />)
  await waitFor(() => expect(transport.requests).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve))
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByText('Executable path'))
  expect((await screen.findByRole('alert')).textContent).toContain('Paths are unavailable')
  expect(screen.getByLabelText('Codex executable path')).toHaveProperty('disabled', true)
})
