// @vitest-environment happy-dom
import { methods } from '@harness/contracts'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'

const shell = vi.hoisted(() => ({
  reveal: vi.fn(async (_path: string, _root: string) => {}),
}))

vi.mock('../../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../bridge.js')>()),
  canRevealProjectFile: true,
  revealProjectFile: shell.reveal,
}))

const { WorkspaceFiles } = await import('./WorkspaceFiles.js')

// An isolated chat lists its own checkout; the files there are not the project's copies.
const ROOT = 'C:\\checkouts\\site-chat-1'

const entry = (name: string, path: string, kind: 'file' | 'directory', restricted = false) => ({
  name,
  path,
  kind,
  size: 0,
  modifiedAt: 0,
  restricted,
})

function transport(root: string | null = ROOT) {
  return new TestTransport((method, params) => {
    if (method === 'workspace.listDirectory') {
      const request = methods[method].params.parse(params)
      return request.directory === 'src'
        ? {
            path: 'src',
            ...(root ? { root } : {}),
            entries: [entry('app.ts', 'src/app.ts', 'file')],
          }
        : {
            path: '',
            ...(root ? { root } : {}),
            entries: [entry('src', 'src', 'directory'), entry('.env', '.env', 'file', true)],
          }
    }
    if (method === 'workspace.readFile') {
      const request = methods[method].params.parse(params)
      return {
        name: 'app.ts',
        path: request.path,
        size: 6,
        binary: false,
        truncated: false,
        content: 'app',
      }
    }
    throw new Error(`Unhandled test request: ${method}`)
  })
}

afterEach(() => {
  cleanup()
  shell.reveal.mockReset()
})

describe('WorkspaceFiles paths', () => {
  it('shows the checkout, a folder, a file and the open file where they are', async () => {
    render(
      <WorkspaceFiles
        transport={transport()}
        projectPath="C:\\projects\\site"
        projectName="site"
        threadId="chat-1"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'site' }))
    expect(shell.reveal).toHaveBeenLastCalledWith(ROOT, ROOT)

    const folder = await screen.findByTitle('src')
    fireEvent.contextMenu(folder)
    expect(shell.reveal).toHaveBeenLastCalledWith(`${ROOT}\\src`, ROOT)

    fireEvent.click(folder)
    const file = await screen.findByTitle('src/app.ts')
    fireEvent.contextMenu(file)
    expect(shell.reveal).toHaveBeenLastCalledWith(`${ROOT}\\src\\app.ts`, ROOT)

    fireEvent.click(file)
    fireEvent.click(await screen.findByRole('button', { name: 'src/app.ts' }))
    expect(shell.reveal).toHaveBeenLastCalledWith(`${ROOT}\\src\\app.ts`, ROOT)

    // A protected entry is not offered.
    const calls = shell.reveal.mock.calls.length
    fireEvent.contextMenu(screen.getByTitle('.env is protected'))
    expect(shell.reveal).toHaveBeenCalledTimes(calls)
  })

  it('says when a file could not be shown', async () => {
    shell.reveal.mockRejectedValueOnce(new Error('ENOENT'))
    render(<WorkspaceFiles transport={transport()} projectPath="C:\\projects\\site" />)
    fireEvent.contextMenu(await screen.findByTitle('src'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not show src'))
  })

  it('keeps the paths as text when the server does not name its folder', async () => {
    render(
      <WorkspaceFiles
        transport={transport(null)}
        projectPath="/projects/site"
        projectName="site"
      />,
    )
    await screen.findByTitle('src')
    expect(screen.queryByRole('button', { name: 'site' })).toBeNull()
    fireEvent.contextMenu(screen.getByTitle('src'))
    expect(shell.reveal).not.toHaveBeenCalled()
  })
})
