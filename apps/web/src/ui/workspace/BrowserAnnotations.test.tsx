// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Transport } from '../../transport.js'
import { BrowserAnnotations, type AnnotationGuest } from './BrowserAnnotations.js'
import type { AnnotationDraft } from './browser-annotations.js'

const target = {
  selector: '#heading',
  text: 'Heading',
  box: { x: 10, y: 20, width: 80, height: 40 },
}
const drawImage = vi.fn()
beforeEach(() => {
  vi.spyOn(Image.prototype, 'decode').mockResolvedValue(undefined)
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockResolvedValue({ width: 800, height: 600, close: vi.fn() }),
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/png;base64,cGl4ZWxz',
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup(imagesSupported = true) {
  const view = document.createElement('div') as AnnotationGuest
  view.executeJavaScript = vi
    .fn()
    .mockResolvedValue({ width: 400, height: 300, scrollX: 0, scrollY: 0, targets: [target] })
  view.capturePage = vi
    .fn()
    .mockResolvedValue({ toDataURL: () => 'data:image/png;base64,cGl4ZWxz' })
  view.getURL = () => 'http://127.0.0.1:6444'
  const save = vi.fn().mockResolvedValue({ path: '/test/annotation.png' })
  const onDraft = vi.fn<(draft: AnnotationDraft) => void>()
  const onExit = vi.fn()
  const props = {
    view,
    enabled: true,
    imagesSupported,
    transport: { request: save } as unknown as Transport,
    onDraft,
    onExit,
  }
  const rendered = render(<BrowserAnnotations {...props} />)
  return { ...rendered, props, save, onDraft, view }
}

async function pin() {
  fireEvent.click(screen.getByLabelText('Annotate page'), { clientX: 30, clientY: 40 })
  const input = await screen.findByLabelText('Comment 1')
  fireEvent.change(input, { target: { value: 'Make this smaller' } })
  fireEvent.click(screen.getByText('Save comment'))
}

it('preserves pins on upload failure and clears only after ordinary send acceptance', async () => {
  const { save, onDraft } = setup()
  await pin()
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 20, 40, 160, 80, 0, 0, 160, 80)
  save.mockRejectedValueOnce(new Error('offline'))
  fireEvent.click(screen.getByText('Add 1 to composer'))
  await screen.findByText(/Could not add annotations/)
  expect(screen.getByText('1. Make this smaller')).toBeTruthy()
  fireEvent.click(screen.getByText('Add 1 to composer'))
  await waitFor(() => expect(onDraft).toHaveBeenCalledTimes(1))
  const draft = onDraft.mock.calls[0]![0]
  expect(draft.attachments).toEqual(['/test/annotation.png'])
  expect(draft.text).toContain('"selector":"#heading"')
  expect(screen.getByText('1. Make this smaller')).toBeTruthy()
  act(() => draft.onSent())
  expect(screen.queryByText('1. Make this smaller')).toBeNull()
})

it('uses text only when images are unsupported and restores browsing on exit', async () => {
  const { save, onDraft, props, rerender, view } = setup(false)
  await pin()
  fireEvent.click(screen.getByText('Add 1 to composer'))
  await waitFor(() => expect(onDraft).toHaveBeenCalledTimes(1))
  expect(save).not.toHaveBeenCalled()
  expect(onDraft.mock.calls[0]![0].attachments).toEqual([])
  expect(screen.getByText(/This model does not support images/)).toBeTruthy()
  fireEvent.keyDown(screen.getByLabelText('Annotate page'), { key: 'Escape' })
  expect(props.onExit).toHaveBeenCalledTimes(1)
  rerender(<BrowserAnnotations {...props} enabled={false} />)
  expect(screen.queryByLabelText('Annotate page')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  const calls = vi.mocked(view.executeJavaScript).mock.calls.length
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(vi.mocked(view.executeJavaScript).mock.calls).toHaveLength(calls)
})
