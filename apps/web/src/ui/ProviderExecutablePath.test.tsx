// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TestTransport } from '../test-transport.js'
import { ProviderExecutablePath } from './ProviderExecutablePath.js'

afterEach(cleanup)

it('saves, reports invalid paths, and resets to discovery', async () => {
  const changed = vi.fn()
  const transport = new TestTransport((method, params) => {
    if (method === 'providers.executablePaths') return { codex: '/old/codex' }
    if (method === 'providers.updateExecutablePath') {
      const { path } = params as { path: string }
      if (path === '/missing') throw new Error('Executable does not exist')
      return path ? { codex: path } : {}
    }
    throw new Error('Unexpected request')
  })
  render(
    <ProviderExecutablePath
      source="codex"
      name="Codex"
      transport={transport}
      onChanged={changed}
    />,
  )
  const input = await screen.findByLabelText('Codex executable path')
  await waitFor(() => expect(input).toHaveProperty('value', '/old/codex'))
  fireEvent.change(input, { target: { value: '/missing' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Executable does not exist')
  fireEvent.change(input, { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(transport.requests.at(-1)).toEqual({
    method: 'providers.updateExecutablePath',
    params: { source: 'codex', path: '' },
  })
})
