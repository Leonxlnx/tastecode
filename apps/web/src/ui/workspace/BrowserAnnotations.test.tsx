// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserAnnotations, type AnnotationGuest } from './BrowserAnnotations.js'
import { composerChips, composerWireText } from '../composer-chips.js'
import { browserComment, resetBrowserComments } from '../browser-comments.js'
import type { AnnotationDraft } from './browser-annotations.js'

const save = vi.hoisted(() => vi.fn())
vi.mock('../../bridge.js', () => ({ savePastedFile: save }))

const target = {
  selector: '#heading',
  tag: 'h1',
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
  resetBrowserComments()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup(imagesSupported = true) {
  const view = document.createElement('div') as unknown as AnnotationGuest
  view.executeJavaScript = vi
    .fn()
    .mockResolvedValue({ width: 400, height: 300, targets: [target], hit: target })
  view.capturePage = vi
    .fn()
    .mockResolvedValue({ toDataURL: () => 'data:image/png;base64,cGl4ZWxz' })
  view.getURL = () => 'http://127.0.0.1:6444'
  view.getTitle = () => 'Fixture page'
  save.mockReset().mockResolvedValue({ path: '/test/annotation.png' })
  const onDraft = vi.fn<(draft: AnnotationDraft) => void>()
  const onExit = vi.fn()
  const props = {
    view,
    enabled: true,
    imagesSupported,
    onDraft,
    onExit,
  }
  const rendered = render(<BrowserAnnotations {...props} />)
  return { ...rendered, props, save, onDraft, view }
}

const clickPage = () =>
  fireEvent.click(screen.getByLabelText('Annotate page'), { clientX: 30, clientY: 40 })

async function pin() {
  clickPage()
  const input = await screen.findByLabelText('Comment 1')
  fireEvent.change(input, { target: { value: 'Make this smaller' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByRole('button', { name: 'Add to chat' })
}

it('hands the round to the composer, and keeps it when an image cannot be saved', async () => {
  const { save, onDraft, props } = setup()
  await pin()
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 20, 40, 160, 80, 0, 0, 160, 80)
  save.mockRejectedValueOnce(new Error('offline'))
  fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
  await screen.findByText(/Could not add these/)
  expect(onDraft).not.toHaveBeenCalled()
  expect(screen.getByText('Make this smaller')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
  await waitFor(() => expect(onDraft).toHaveBeenCalledTimes(1))
  const draft = onDraft.mock.calls[0]![0]
  expect(draft.attachments).toEqual([])
  expect(composerWireText(draft.text)).toContain('Element: "#heading"')
  const chip = composerChips(draft.text)[0]!
  expect(chip.name).toBe('Make this smaller')
  expect(browserComment(chip.commentId!)).toMatchObject({
    title: 'Fixture page',
    image: '/test/annotation.png',
  })
  expect(screen.queryByText('Make this smaller')).toBeNull()
  expect(props.onExit).toHaveBeenCalledTimes(1)
})

it('says up front when comments go as text, and stops reading the page on exit', async () => {
  const { save, onDraft, props, rerender, view } = setup(false)
  await pin()
  expect(screen.getByText(/Text only/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
  await waitFor(() => expect(onDraft).toHaveBeenCalledTimes(1))
  expect(save).not.toHaveBeenCalled()
  expect(onDraft.mock.calls[0]![0].attachments).toEqual([])
  expect(onDraft.mock.calls[0]![0].text).not.toContain('screenshots')
  rerender(<BrowserAnnotations {...props} enabled={false} />)
  expect(screen.queryByLabelText('Annotate page')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  const calls = vi.mocked(view.executeJavaScript).mock.calls.length
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(vi.mocked(view.executeJavaScript).mock.calls).toHaveLength(calls)
})

it('lets Escape close the comment box first and leave the mode second', async () => {
  const { props } = setup()
  clickPage()
  const input = await screen.findByLabelText('Comment 1')
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByLabelText('Comment 1')).toBeNull()
  expect(props.onExit).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByLabelText('Annotate page'), { key: 'Escape' })
  expect(props.onExit).toHaveBeenCalledTimes(1)
})

it('keeps a line break on Shift+Enter and refuses an empty comment', async () => {
  setup()
  clickPage()
  const input = await screen.findByLabelText('Comment 1')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(screen.getByLabelText('Comment 1')).toBeTruthy()
  fireEvent.change(input, { target: { value: 'First' } })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(screen.getByLabelText('Comment 1')).toBeTruthy()
})

it('refuses a comment of invisible characters and keeps the lines of a real one', async () => {
  const { onDraft } = setup()
  clickPage()
  const input = await screen.findByLabelText('Comment 1')
  fireEvent.change(input, { target: { value: '\u200B' } })
  expect(screen.getByRole('button', { name: 'Comment' })).toHaveProperty('disabled', true)
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(screen.getByLabelText('Comment 1')).toBeTruthy()

  fireEvent.change(input, { target: { value: 'First line\nSecond \u{1F469}\u200D\u{1F4BB}' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.click(await screen.findByRole('button', { name: 'Add to chat' }))
  await waitFor(() => expect(onDraft).toHaveBeenCalledOnce())
  const chip = composerChips(onDraft.mock.calls[0]![0].text)[0]!
  expect(browserComment(chip.commentId!)?.comment).toBe(
    'First line\nSecond \u{1F469}\u200D\u{1F4BB}',
  )
})

it('gives up on a page that stops answering and takes the next click', async () => {
  const { view } = setup()
  await waitFor(() => expect(view.executeJavaScript).toHaveBeenCalled())
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    vi.mocked(view.executeJavaScript).mockReturnValueOnce(new Promise(() => undefined))
    clickPage()
    await act(() => vi.advanceTimersByTimeAsync(2_100))
  } finally {
    vi.useRealTimers()
  }
  clickPage()
  expect(await screen.findByLabelText('Comment 1')).toBeTruthy()
})

it('opens the box on a page whose screenshot never arrives, and takes the next click', async () => {
  const { view } = setup()
  vi.mocked(view.capturePage).mockReturnValue(new Promise(() => undefined))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    clickPage()
    await act(() => vi.advanceTimersByTimeAsync(10_100))
  } finally {
    vi.useRealTimers()
  }
  const input = await screen.findByLabelText('Comment 1')
  fireEvent.change(input, { target: { value: 'No picture' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(await screen.findByRole('button', { name: 'Add to chat' })).toHaveProperty(
    'disabled',
    false,
  )
})

it('reopens a pinned element instead of pinning it twice', async () => {
  setup()
  await pin()
  clickPage()
  const input = (await screen.findByLabelText('Comment 1')) as HTMLTextAreaElement
  expect(input.value).toBe('Make this smaller')
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  expect(screen.queryByText('Make this smaller')).toBeNull()
  expect(screen.getByText('Click anything to comment')).toBeTruthy()
})
