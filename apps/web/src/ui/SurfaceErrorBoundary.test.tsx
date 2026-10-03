// @vitest-environment happy-dom
import { lazy } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RendererErrorBoundary } from '../RendererErrorBoundary.js'
import { reportRendererError } from '../bridge.js'
import { surfaceLoadFailed } from '../surface-load-error.js'
import { SurfaceErrorBoundary } from './SurfaceErrorBoundary.js'

vi.mock('../bridge.js', () => ({
  isDesktop: true,
  reportRendererError: vi.fn(),
  writeClipboardText: vi.fn(async () => {}),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const failure = new Error('settings render failed')
let broken = true
function Flaky() {
  if (broken) throw failure
  return <p>Settings ready</p>
}

describe('surface recovery', () => {
  it('keeps the rest of the window running when the surface fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    broken = true
    render(
      <RendererErrorBoundary>
        <p>Chat</p>
        <SurfaceErrorBoundary name="Settings" onClose={() => {}}>
          <Flaky />
        </SurfaceErrorBoundary>
      </RendererErrorBoundary>,
    )
    expect(screen.getByText('Chat')).toBeTruthy()
    expect(screen.getByRole('heading').textContent).toBe('Settings ran into a problem')
    expect(screen.queryByText(/couldn’t display this window/)).toBeNull()
    expect(reportRendererError).toHaveBeenCalledWith(failure)
  })

  it('renders the surface again on Try again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    broken = true
    render(
      <SurfaceErrorBoundary name="Settings" onClose={() => {}}>
        <Flaky />
      </SurfaceErrorBoundary>,
    )
    const retry = screen.getByRole('button', { name: 'Try again' })
    expect(document.activeElement).toBe(retry)
    broken = false
    fireEvent.click(retry)
    expect(screen.getByText('Settings ready')).toBeTruthy()
  })

  it('goes back to the app from the button or Escape', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    broken = true
    const onClose = vi.fn()
    render(
      <SurfaceErrorBoundary name="Settings" onClose={onClose}>
        <Flaky />
      </SurfaceErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back to app' }))
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('offers a reload when the surface module failed to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const Missing = lazy(() =>
      Promise.reject<{ default: () => null }>(
        new TypeError('Failed to fetch dynamically imported module'),
      ).catch(surfaceLoadFailed),
    )
    const reload = vi.fn()
    render(
      <SurfaceErrorBoundary name="Settings" onClose={() => {}} reload={reload}>
        <Missing />
      </SurfaceErrorBoundary>,
    )
    expect((await screen.findByRole('heading')).textContent).toBe('Settings couldn’t load')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reload window' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
