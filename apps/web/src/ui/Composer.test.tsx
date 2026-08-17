// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PickedAttachment } from '../bridge.js'
import type { ModelChoice } from '../model-catalog.js'
import { emptyThread, reduce } from '../thread-store.js'
import { requiredInstance } from '../test-dom.js'
import { TestTransport, type TestRequestResolver } from '../test-transport.js'
import { Composer, type ComposerBridge } from './Composer.js'

const bridge = {
  pickFiles: vi.fn<ComposerBridge['pickFiles']>(),
  previewViewedImage: vi.fn<ComposerBridge['previewViewedImage']>(),
  revealPath: vi.fn<ComposerBridge['revealPath']>(),
  savePastedFile: vi.fn<ComposerBridge['savePastedFile']>(),
} satisfies ComposerBridge

beforeEach(() => {
  bridge.pickFiles.mockResolvedValue([])
  bridge.previewViewedImage.mockResolvedValue(undefined)
  bridge.savePastedFile.mockResolvedValue({
    path: '/tmp/pasted-image.png',
    name: 'pasted-image.png',
  })
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:pasted-image'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('Composer docking motion', () => {
  it('animates the bounded composer box with transform-only docking motion', () => {
    let top = 700
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(100, top, 620, 120),
    )

    const animation = {
      id: '',
      cancel: vi.fn(),
      finished: new Promise<void>(() => undefined),
    }
    const animate = vi.fn(function (this: Element) {
      return animation
    })
    const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: animate,
    })

    try {
      const view = renderComposer(vi.fn(), { newSession: false })
      const box = document.querySelector('.composer__box')
      top = 280

      view.rerenderComposer({ newSession: true })

      expect(animate).toHaveBeenCalledOnce()
      expect(animate.mock.instances[0]).toBe(box)
      expect(animate).toHaveBeenCalledWith(
        [{ transform: 'translate3d(0px, 420px, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
        { duration: 320, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      )
    } finally {
      if (originalAnimate) {
        Object.defineProperty(Element.prototype, 'animate', originalAnimate)
      } else {
        Reflect.deleteProperty(Element.prototype, 'animate')
      }
    }
  })
})

describe('Composer media attachments', () => {
  it('previews a pasted image and sends its materialized path', async () => {
    const onSend = vi.fn()
    renderComposer(onSend)
    const composer = screen.getByPlaceholderText('Do anything')
    const image = new File(['image bytes'], 'Screenshot.png', { type: 'image/png' })

    fireEvent.paste(composer, { clipboardData: { files: [image] } })

    expect(screen.getByRole('button', { name: 'Open Screenshot.png' })).toBeTruthy()
    expect(bridge.savePastedFile).toHaveBeenCalledWith(image)
    fireEvent.change(composer, { target: { value: 'What is in this image?' } })
    await waitFor(() =>
      expect(
        requiredInstance(screen.getByRole('button', { name: 'Send' }), HTMLButtonElement).disabled,
      ).toBe(false),
    )
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('What is in this image?', ['/tmp/pasted-image.png'])
    expect(screen.queryByRole('button', { name: 'Open Screenshot.png' })).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pasted-image')
  })

  it('removes a pasted image before sending', () => {
    renderComposer(vi.fn())
    const composer = screen.getByPlaceholderText('Do anything')
    const image = new File(['image bytes'], 'Screenshot.png', { type: 'image/png' })

    fireEvent.paste(composer, { clipboardData: { files: [image] } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Screenshot.png' }))

    expect(screen.queryByRole('button', { name: 'Open Screenshot.png' })).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pasted-image')
  })

  it('opens a zoomable, downloadable viewer and closes it with Escape', () => {
    renderComposer(vi.fn())
    const composer = screen.getByPlaceholderText('Do anything')
    const image = new File(['image bytes'], 'Screenshot.png', { type: 'image/png' })

    fireEvent.paste(composer, { clipboardData: { files: [image] } })
    const open = screen.getByRole('button', { name: 'Open Screenshot.png' })
    open.focus()
    fireEvent.click(open)

    expect(screen.getByRole('dialog', { name: 'Preview Screenshot.png' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Screenshot.png' })).toBeTruthy()
    const download = screen.getByRole('link', { name: 'Download image' })
    expect(download.getAttribute('href')).toBe('blob:pasted-image')
    expect(download.getAttribute('download')).toBe('Screenshot.png')
    expect(screen.getByText('100%')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByText('125%')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Preview Screenshot.png' })).toBeNull()
    expect(document.activeElement).toBe(open)
  })

  it('rejects an unsupported image before materializing it and preserves the draft', () => {
    renderComposer(vi.fn(), { attachmentsSupported: false })
    const composer = requiredInstance(
      screen.getByPlaceholderText('Do anything'),
      HTMLTextAreaElement,
    )
    const image = new File(['image bytes'], 'Screenshot.png', { type: 'image/png' })
    fireEvent.change(composer, { target: { value: 'Keep this draft' } })

    fireEvent.paste(composer, { clipboardData: { files: [image] } })

    expect(bridge.savePastedFile).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Open Screenshot.png' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(
      'Attachments aren’t supported by this source.',
    )
    expect(composer.value).toBe('Keep this draft')
  })

  it.each([
    [
      'image',
      'reference.png',
      '/work/reference.png',
      'tastecode-attachment://preview/image',
      'tastecode-attachment://preview/image?thumbnail=1',
    ],
    [
      'video',
      'walkthrough.mp4',
      '/work/walkthrough.mp4',
      'tastecode-attachment://preview/video',
      'tastecode-attachment://preview/video?thumbnail=1',
    ],
  ] as const)(
    'previews a picked %s and opens it in the media viewer',
    async (mediaType, name, path, previewUrl, thumbnailUrl) => {
      bridge.pickFiles.mockResolvedValueOnce([{ path, name, mediaType, previewUrl, thumbnailUrl }])
      renderComposer(vi.fn())

      fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
      const open = await screen.findByRole('button', { name: `Open ${name}` })
      expect(open.querySelector('video')).toBeNull()
      expect(open.querySelector('img')?.getAttribute('src')).toBe(thumbnailUrl)
      open.focus()
      fireEvent.click(open)

      expect(screen.getByRole('dialog', { name: `Preview ${name}` })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
      expect(bridge.revealPath).toHaveBeenCalledWith(path)
      if (mediaType === 'image') {
        expect(screen.getByRole('img', { name })).toBeTruthy()
        expect(screen.getByText('100%')).toBeTruthy()
      } else {
        const player = requiredInstance(screen.getByLabelText(name), HTMLVideoElement)
        expect(player.tagName).toBe('VIDEO')
        expect(player.hasAttribute('controls')).toBe(false)
        expect(screen.getByRole('button', { name: 'Play video' })).toBeTruthy()
        expect(screen.getByRole('slider', { name: 'Video progress' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Mute video' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Enter fullscreen' })).toBeTruthy()
        expect(document.querySelector('.media-viewer__identity')).toBeNull()
        expect(screen.queryByText('100%')).toBeNull()
      }

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: `Preview ${name}` })).toBeNull()
      expect(document.activeElement).toBe(open)
    },
  )

  it('previews and materializes a pasted video', async () => {
    bridge.savePastedFile.mockResolvedValueOnce({
      path: '/tmp/walkthrough.mp4',
      name: 'walkthrough.mp4',
      mediaType: 'video',
      previewUrl: 'tastecode-attachment://preview/pasted-video',
      thumbnailUrl: 'tastecode-attachment://preview/pasted-video?thumbnail=1',
    })
    renderComposer(vi.fn())
    const composer = screen.getByPlaceholderText('Do anything')
    const video = new File(['video bytes'], 'walkthrough.mp4', { type: 'video/mp4' })

    fireEvent.paste(composer, { clipboardData: { files: [video] } })
    const open = screen.getByRole('button', { name: 'Open walkthrough.mp4' })
    expect(open.querySelector('video')).toBeNull()
    await waitFor(() =>
      expect(open.querySelector('img')?.getAttribute('src')).toBe(
        'tastecode-attachment://preview/pasted-video?thumbnail=1',
      ),
    )
    fireEvent.click(open)

    expect(screen.getByRole('dialog', { name: 'Preview walkthrough.mp4' })).toBeTruthy()
    const player = requiredInstance(screen.getByLabelText('walkthrough.mp4'), HTMLVideoElement)
    expect(player.tagName).toBe('VIDEO')
    expect(player.hasAttribute('controls')).toBe(false)
    expect(bridge.savePastedFile).toHaveBeenCalledWith(video)
  })

  it('materializes a pasted non-media file and sends its path', async () => {
    const type = 'application/pdf'
    const name = 'brief.pdf'
    const path = '/tmp/brief.pdf'
    bridge.savePastedFile.mockResolvedValueOnce({ path, name })
    const onSend = vi.fn()
    renderComposer(onSend)
    const composer = screen.getByPlaceholderText('Do anything')
    const file = new File(['file bytes'], name, { type })

    fireEvent.paste(composer, { clipboardData: { files: [file] } })

    expect(await screen.findByText(name)).toBeTruthy()
    expect(bridge.savePastedFile).toHaveBeenCalledWith(file)
    fireEvent.change(composer, { target: { value: 'Inspect this attachment' } })
    await waitFor(() =>
      expect(
        requiredInstance(screen.getByRole('button', { name: 'Send' }), HTMLButtonElement).disabled,
      ).toBe(false),
    )
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('Inspect this attachment', [path])
  })
})

describe('Composer attachment source switching', () => {
  it('keeps existing attachments removable but blocks sending them through an unsupported source', async () => {
    bridge.pickFiles.mockResolvedValue([{ path: '/work/reference.txt', name: 'reference.txt' }])
    const onSend = vi.fn()
    const view = renderComposer(onSend)
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
    expect(await screen.findByText('reference.txt')).toBeTruthy()

    view.rerenderComposer({ attachmentsSupported: false })
    const composer = requiredInstance(
      screen.getByPlaceholderText('Do anything'),
      HTMLTextAreaElement,
    )
    fireEvent.change(composer, { target: { value: 'Keep this with the attachment' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()
    expect(composer.value).toBe('Keep this with the attachment')
    expect(screen.getByText('reference.txt')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove reference.txt' })).toBeTruthy()
    expect(
      requiredInstance(screen.getByRole('button', { name: 'Send' }), HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe(
      'Remove attachments or switch to a source that supports them.',
    )
  })
})

describe('Composer send handoff', () => {
  it('switches directly to Stop without starting a looping send animation', () => {
    const onSend = vi.fn()
    const view = renderComposer(onSend)
    const composer = screen.getByPlaceholderText('Do anything')

    fireEvent.change(composer, { target: { value: 'Ship this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    view.rerenderComposer({ running: true })

    expect(onSend).toHaveBeenCalledWith('Ship this', [])
    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(stop.querySelector('.lucide-loader-circle')).toBeNull()
    expect(stop.closest('.composer__send-beam')?.hasAttribute('data-active')).toBe(false)
  })

  it('keeps model selection available for the next prompt while a turn runs', () => {
    const models = [
      {
        key: 'codex:gpt-5.6-sol',
        provider: 'codex',
        sourceName: 'Codex',
        mark: 'openai',
        model: {
          id: 'gpt-5.6-sol',
          displayName: 'GPT-5.6 Sol',
          isDefault: true,
          reasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
          serviceTiers: [],
        },
      },
      {
        key: 'codex:gpt-5.6-luna',
        provider: 'codex',
        sourceName: 'Codex',
        mark: 'openai',
        model: {
          id: 'gpt-5.6-luna',
          displayName: 'GPT-5.6 Luna',
          isDefault: false,
          reasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
          serviceTiers: [],
        },
      },
    ] satisfies ModelChoice[]
    const onModelChange = vi.fn()

    renderComposer(vi.fn(), {
      models,
      modelId: models[0]!.key,
      effort: 'medium',
      running: true,
      onModelChange,
    })

    const trigger = requiredInstance(
      screen.getByRole('button', { name: 'Model and reasoning' }),
      HTMLButtonElement,
    )
    expect(trigger.disabled).toBe(false)
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.6 Luna through Codex' }))

    expect(onModelChange).toHaveBeenCalledWith('codex:gpt-5.6-luna')
  })
})

describe('Composer queue', () => {
  it('shows the first queued media and restores every preview when editing', async () => {
    const previews = new Map([
      [
        '/work/reference.png',
        {
          path: '/work/reference.png',
          name: 'reference.png',
          mediaType: 'image',
          previewUrl: 'tastecode-attachment://preview/reference',
          thumbnailUrl: 'tastecode-attachment://preview/reference?thumbnail=1',
        } satisfies PickedAttachment,
      ],
      [
        '/work/walkthrough.mp4',
        {
          path: '/work/walkthrough.mp4',
          name: 'walkthrough.mp4',
          mediaType: 'video',
          previewUrl: 'tastecode-attachment://preview/walkthrough',
          thumbnailUrl: 'tastecode-attachment://preview/walkthrough?thumbnail=1',
        } satisfies PickedAttachment,
      ],
    ])
    bridge.previewViewedImage.mockImplementation(async (reference: string) =>
      previews.get(reference),
    )
    const onDeleteQueuedTurn = vi.fn()
    renderComposer(vi.fn(), {
      running: true,
      queuedTurns: [
        {
          id: 'queued-media',
          text: 'Use these references',
          attachments: ['/work/notes.txt', '/work/reference.png', '/work/walkthrough.mp4'],
          createdAt: 1,
        },
      ],
      onDeleteQueuedTurn,
    })

    const queuedPreview = await screen.findByRole('button', {
      name: 'Open queued preview of reference.png',
    })
    expect(queuedPreview.querySelector('img')?.getAttribute('src')).toBe(
      'tastecode-attachment://preview/reference?thumbnail=1',
    )
    expect(
      screen.queryByRole('button', { name: 'Open queued preview of walkthrough.mp4' }),
    ).toBeNull()

    fireEvent.click(queuedPreview)
    expect(screen.getByRole('dialog', { name: 'Preview reference.png' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Use these references' }))

    const imagePreview = await screen.findByRole('button', { name: 'Open reference.png' })
    const videoPreview = await screen.findByRole('button', { name: 'Open walkthrough.mp4' })
    expect(imagePreview.querySelector('img')?.getAttribute('src')).toBe(
      'tastecode-attachment://preview/reference?thumbnail=1',
    )
    expect(videoPreview.querySelector('img')?.getAttribute('src')).toBe(
      'tastecode-attachment://preview/walkthrough?thumbnail=1',
    )
    expect(screen.queryByText('reference.png')).toBeNull()
    expect(screen.queryByText('walkthrough.mp4')).toBeNull()
    expect(screen.getByText('notes.txt')).toBeTruthy()
    expect(onDeleteQueuedTurn).toHaveBeenCalledWith('queued-media')
  })

  it('changes Stop to Queue when a running session has a draft and Enter queues it', () => {
    const onSend = vi.fn()
    const onInterrupt = vi.fn()
    renderComposer(onSend, { running: true, onInterrupt })
    const composer = screen.getByPlaceholderText('Do anything')

    const action = screen.getByRole('button', { name: 'Stop' })
    fireEvent.change(composer, { target: { value: 'Do this next' } })
    expect(screen.getByRole('button', { name: 'Queue' })).toBe(action)
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('Do this next', [])
    expect(onInterrupt).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBe(action)
    fireEvent.click(action)
    expect(onInterrupt).toHaveBeenCalledOnce()
  })

  it('steers a running session with Ctrl+Enter', () => {
    const onSend = vi.fn()
    const onSteer = vi.fn()
    renderComposer(onSend, { running: true, canSteerQueue: true, onSteer })
    const composer = screen.getByPlaceholderText('Do anything')

    fireEvent.change(composer, { target: { value: 'Use this direction now' } })
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true })

    expect(onSteer).toHaveBeenCalledWith('Use this direction now', [])
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByText('Next message')).toBeNull()
  })

  it('offers a visible Steer action while Enter still queues', () => {
    const onSend = vi.fn()
    const onSteer = vi.fn()
    renderComposer(onSend, { running: true, canSteerQueue: true, onSteer })
    const composer = screen.getByPlaceholderText('Do anything')

    fireEvent.change(composer, { target: { value: 'Use this direction now' } })
    fireEvent.click(screen.getByRole('button', { name: 'Steer current draft' }))

    expect(onSteer).toHaveBeenCalledWith('Use this direction now', [])
    expect(onSend).not.toHaveBeenCalled()
  })

  it('offers drag reorder, steer, remove, and edit actions for queued prompts', async () => {
    const onDeleteQueuedTurn = vi.fn()
    const onMoveQueuedTurn = vi.fn()
    const onSteerQueuedTurn = vi.fn()
    renderComposer(vi.fn(), {
      running: true,
      canSteerQueue: true,
      queuedTurns: [
        {
          id: 'queued-1',
          text: 'Polish the queue',
          attachments: ['/work/reference.png'],
          createdAt: 1,
        },
        {
          id: 'queued-2',
          text: 'Run the tests',
          attachments: [],
          createdAt: 2,
        },
        {
          id: 'queued-3',
          text: 'Ship the build',
          attachments: [],
          createdAt: 3,
        },
      ],
      onDeleteQueuedTurn,
      onMoveQueuedTurn,
      onSteerQueuedTurn,
      onDraftChange: onDeleteQueuedTurn,
    })

    fireEvent.click(screen.getAllByRole('button', { name: 'Steer' })[0]!)
    expect(onSteerQueuedTurn).toHaveBeenCalledWith('queued-1')

    const source = screen.getByText('Polish the queue').closest('.queue-row')!
    const target = screen.getByText('Ship the build').closest('.queue-row')!
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      bottom: 138,
      height: 38,
      left: 0,
      right: 400,
      top: 100,
      width: 400,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    })
    const dataTransfer = { dropEffect: 'none', effectAllowed: 'none', setData: vi.fn() }
    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(target, { clientY: 4, dataTransfer })
    expect(target.getAttribute('data-drop-position')).toBe('after')
    fireEvent.drop(target, { clientY: 4, dataTransfer })
    await waitFor(() => expect(onMoveQueuedTurn).toHaveBeenCalledTimes(2))
    expect(onMoveQueuedTurn).toHaveBeenNthCalledWith(1, 'queued-1', 'down')
    expect(onMoveQueuedTurn).toHaveBeenNthCalledWith(2, 'queued-1', 'down')
    expect(screen.queryByRole('button', { name: /Move .* (up|down)/ })).toBeNull()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag Run the tests to reorder' }), {
      key: 'ArrowUp',
    })
    expect(onMoveQueuedTurn).toHaveBeenCalledTimes(3)

    fireEvent.click(screen.getByRole('button', { name: 'Edit Polish the queue' }))
    expect(
      requiredInstance(screen.getByPlaceholderText('Do anything'), HTMLTextAreaElement).value,
    ).toBe('Polish the queue')
    expect(onDeleteQueuedTurn).toHaveBeenCalledWith('queued-1')
    expect(onDeleteQueuedTurn).toHaveBeenCalledWith('Polish the queue')
  })
})

describe('Composer prompts', () => {
  it('opens the file picker directly from the plus button', () => {
    renderComposer(vi.fn())

    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))

    expect(bridge.pickFiles).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the built-in side-chat slash commands out of the resource picker', () => {
    const onSend = vi.fn()
    renderComposer(onSend, { transport: populatedResourceTransport() })

    const composer = requiredInstance(
      screen.getByPlaceholderText('Do anything'),
      HTMLTextAreaElement,
    )
    fireEvent.change(composer, { target: { value: '/side' } })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('/side', [])
  })

  it('opens the resource picker from slash and invokes the selected skill canonically', async () => {
    const onSend = vi.fn()
    renderComposer(onSend, { transport: populatedResourceTransport() })
    const composer = requiredInstance(
      screen.getByPlaceholderText('Do anything'),
      HTMLTextAreaElement,
    )

    fireEvent.change(composer, { target: { value: '/air', selectionStart: 4 } })
    await screen.findByRole('option', { name: /Airtable CLI/ })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(screen.getByText('Airtable CLI').closest('.chip--resource')).toBeTruthy()
    expect(composer.value).toBe('')
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('$airtable-cli', [])
  })

  it('opens skills and MCP servers from dollar and selects the active row with Tab', async () => {
    const onSend = vi.fn()
    const transport = populatedResourceTransport()
    renderComposer(onSend, { transport })
    const composer = requiredInstance(
      screen.getByPlaceholderText('Do anything'),
      HTMLTextAreaElement,
    )

    fireEvent.change(composer, { target: { value: '$', selectionStart: 1 } })

    const list = await screen.findByRole('listbox', { name: 'Skills and MCP servers' })
    const skill = screen.getByRole('option', { name: /Airtable CLI/ })
    const mcp = screen.getByRole('option', { name: /Official Docs/ })
    expect(list).toBeTruthy()
    expect(skill.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(composer, { key: 'ArrowDown' })
    await waitFor(() => expect(mcp.getAttribute('aria-selected')).toBe('true'))
    fireEvent.keyDown(composer, { key: 'Tab' })

    expect(screen.queryByRole('listbox', { name: 'Skills and MCP servers' })).toBeNull()
    expect(screen.getByText('Official Docs').closest('.chip--resource')).toBeTruthy()
    expect(composer.value).toBe('')
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('@officialDocs', [])
  })

  it('opens the combined picker from at, filters it, and highlights a clicked skill as a chip', async () => {
    const onSend = vi.fn()
    renderComposer(onSend, { transport: populatedResourceTransport() })
    const composer = screen.getByPlaceholderText('Do anything')

    fireEvent.change(composer, { target: { value: '@air', selectionStart: 4 } })

    const skill = await screen.findByRole('option', { name: /Airtable CLI/ })
    expect(screen.queryByRole('option', { name: /Official Docs/ })).toBeNull()
    fireEvent.click(skill)

    const chip = screen.getByText('Airtable CLI').closest('.chip--resource')
    expect(chip?.classList.contains('chip--resource')).toBe(true)
    expect(chip?.querySelector('svg')).toBeTruthy()
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('$airtable-cli', [])
  })

  it('does not offer provider-global resources as project resources', async () => {
    const transport = createResourceTransport(async (method) => {
      if (method === 'skills.list') {
        return {
          capabilities: { inventory: true, configure: true, install: true },
          skills: [
            {
              id: '/skills/global/SKILL.md',
              name: 'global-skill',
              displayName: 'Global skill',
              description: 'A provider-managed skill',
              source: { type: 'provider' },
              scope: 'system',
              enabled: true,
              dependencyErrors: [],
            },
          ],
          errors: [],
        }
      }
      if (method === 'mcp.list') {
        return {
          capabilities: {
            inventory: true,
            add: false,
            update: false,
            remove: false,
            reload: false,
            startOAuth: false,
            cancelOAuth: false,
          },
          servers: [
            {
              id: 'global-docs',
              scope: 'global',
              enabled: true,
              auth: { status: 'not_required' },
              startup: { state: 'ready' },
              tools: [],
              resources: [],
              resourceTemplates: [],
            },
          ],
        }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    renderComposer(vi.fn(), { transport })
    const composer = screen.getByPlaceholderText('Do anything')

    fireEvent.change(composer, { target: { value: '$', selectionStart: 1 } })

    await waitFor(() => expect(transport.requests).toHaveLength(2))
    expect(screen.getByText('No more skills or MCP servers are available.')).toBeTruthy()
    expect(screen.queryByText('Global skill')).toBeNull()
  })

  it('closes the resource picker before Escape interrupts a running turn', async () => {
    const onInterrupt = vi.fn()
    renderComposer(vi.fn(), {
      running: true,
      onInterrupt,
      transport: populatedResourceTransport(),
    })
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: '$', selectionStart: 1 } })
    await screen.findByRole('listbox', { name: 'Skills and MCP servers' })

    fireEvent.keyDown(composer, { key: 'Escape' })
    expect(onInterrupt).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox', { name: 'Skills and MCP servers' })).toBeNull()

    fireEvent.keyDown(composer, { key: 'Escape' })
    expect(onInterrupt).toHaveBeenCalledOnce()
  })
})

describe('Composer permissions', () => {
  it('shows an icon for every mode and offers auto-review only when supported', () => {
    const unsupported = renderComposer(vi.fn())
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    expect(screen.queryByRole('menuitem', { name: /Auto-review/ })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /Ask first/ }).querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Auto-approve/ }).querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Full access/ }).querySelector('svg')).toBeTruthy()

    unsupported.unmount()
    renderComposer(vi.fn(), { autoReviewSupported: true })
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    const autoApprove = screen.getByRole('menuitem', { name: /Auto-approve/ })
    const autoReview = screen.getByRole('menuitem', { name: /Auto-review/ })
    expect(autoApprove.querySelector('.lucide-shield-check')).toBeTruthy()
    expect(autoReview.querySelector('.lucide-scan-eye')).toBeTruthy()
    expect(autoReview.classList.contains('composer__permission-option--auto-review')).toBe(true)
    expect(
      screen
        .getByRole('menuitem', { name: /Full access/ })
        .classList.contains('composer__permission-option--full'),
    ).toBe(true)
  })

  it('colors the selected auto-review and full-access triggers', () => {
    const autoReview = renderComposer(vi.fn(), {
      approval: 'auto-review',
      autoReviewSupported: true,
    })
    expect(
      screen.getByRole('button', { name: 'Permissions' }).querySelector('.tool--review'),
    ).toBeTruthy()

    autoReview.unmount()
    renderComposer(vi.fn(), { approval: 'full' })
    expect(
      screen.getByRole('button', { name: 'Permissions' }).querySelector('.tool--danger'),
    ).toBeTruthy()
  })

  it('stays usable while a session is running so the access level can change mid-chat', () => {
    renderComposer(vi.fn(), { running: true })

    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))

    expect(screen.getByRole('menuitem', { name: /Full access/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Ask first/ })).toBeTruthy()
  })
})

describe('Composer Design mode', () => {
  it('exposes a pressed toggle through its callback', () => {
    const onDesignModeChange = vi.fn()
    const view = renderComposer(vi.fn(), { onDesignModeChange })

    const design = screen.getByRole('button', { name: 'Design' })
    expect(design.getAttribute('aria-pressed')).toBe('false')
    expect(design.closest('.composer__design-beam')?.hasAttribute('data-active')).toBe(false)
    expect(design.closest('.composer__design-button-beam')?.hasAttribute('data-active')).toBe(false)
    fireEvent.click(design)
    expect(onDesignModeChange).toHaveBeenCalledWith(true)

    view.unmount()
    renderComposer(vi.fn(), { designMode: true })
    const activeDesign = screen.getByRole('button', { name: 'Design' })
    expect(activeDesign.getAttribute('aria-pressed')).toBe('true')
    expect(activeDesign.closest('.composer__design-beam')?.hasAttribute('data-active')).toBe(true)
    expect(activeDesign.closest('.composer__design-button-beam')?.hasAttribute('data-active')).toBe(
      true,
    )
  })
})

describe('Composer project requirement', () => {
  it('keeps the draft when send is blocked without a project', () => {
    const onSend = vi.fn()
    const onProjectRequired = vi.fn()
    renderComposer(onSend, {
      projects: [],
      projectPath: undefined,
      projectName: undefined,
      onProjectRequired,
    })
    const composer = requiredInstance(
      screen.getByPlaceholderText('Do anything'),
      HTMLTextAreaElement,
    )

    fireEvent.change(composer, { target: { value: 'Keep this prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(onProjectRequired).toHaveBeenCalledOnce()
    expect(onSend).not.toHaveBeenCalled()
    expect(composer.value).toBe('Keep this prompt')
  })
})

describe('Composer height', () => {
  it('starts at two lines and scrolls only after ten lines', async () => {
    renderComposer(vi.fn())
    const composer = requiredInstance(
      screen.getByPlaceholderText('Do anything'),
      HTMLTextAreaElement,
    )
    let contentHeight = 120
    Object.defineProperty(composer, 'offsetHeight', { configurable: true, value: 68 })
    Object.defineProperty(composer, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight,
    })

    expect(composer.getAttribute('rows')).toBe('2')
    fireEvent.change(composer, { target: { value: 'one\ntwo\nthree' } })
    await waitFor(() => expect(composer.style.height).toBe('120px'))
    expect(composer.style.overflowY).toBe('hidden')

    contentHeight = 300
    fireEvent.change(composer, {
      target: { value: Array.from({ length: 11 }, () => 'line').join('\n') },
    })
    await waitFor(() => expect(composer.style.height).toBe('242px'))
    expect(composer.style.overflowY).toBe('auto')
  })
})

describe('Composer context usage', () => {
  it('shows exact context details on the compact ring', () => {
    renderComposer(vi.fn(), {
      usage: {
        inputTokens: 12_000,
        cachedInputTokens: 0,
        outputTokens: 3_000,
        reasoningTokens: 0,
        totalTokens: 15_000,
        contextWindow: 100_000,
      },
    })

    expect(screen.getByRole('img', { name: /context tokens used \(15%\)/ })).toBeTruthy()
    expect(screen.getByRole('tooltip').textContent).toContain('15% context used')
  })

  it('does not render a false ring restored from cumulative accounting', () => {
    const restored = reduce(emptyThread, {
      type: 'usage.updated',
      usage: {
        inputTokens: 570_000,
        cachedInputTokens: 490_000,
        outputTokens: 25_000,
        reasoningTokens: 6_152,
        totalTokens: 601_152,
        cumulative: true,
        inputIncludesCached: true,
        contextWindow: 258_400,
      },
    })

    renderComposer(vi.fn(), { usage: restored.usage })

    expect(screen.queryByRole('img', { name: /context tokens used/ })).toBeNull()
  })
})

describe('Composer branch shelf', () => {
  it('shows the branch picker only when the project has branches', () => {
    renderComposer(vi.fn())
    expect(screen.getByRole('button', { name: 'Choose branch' })).toBeTruthy()

    cleanup()
    renderComposer(vi.fn(), { branch: undefined, branches: [] })
    expect(screen.queryByRole('button', { name: 'Choose branch' })).toBeNull()
  })

  it('keeps main first and filters branches from the shared search field', () => {
    renderComposer(vi.fn(), {
      branch: 'feature/current',
      branches: ['feature/current', 'main', 'agent/review', 'fix/desktop'],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Choose branch' }))

    const dialog = screen.getByRole('dialog', { name: 'Choose branch' })
    const branchNames = Array.from(dialog.querySelectorAll('.menu__item')).map((item) =>
      item.textContent?.trim(),
    )
    expect(branchNames).toEqual(['main', 'feature/current', 'agent/review', 'fix/desktop'])

    const search = screen.getByRole('searchbox', { name: 'Search branches' })
    fireEvent.change(search, { target: { value: 'agent' } })

    expect(screen.getByRole('menuitem', { name: 'agent/review' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'main' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'feature/current' })).toBeNull()
  })
})

describe('Composer draft replacement', () => {
  it('loads a previous prompt for editing and focuses it', async () => {
    renderComposer(vi.fn(), {
      draftRequest: { text: 'Rewrite this request', request: 1 },
    })

    const composer = requiredInstance(
      screen.getByPlaceholderText('Do anything'),
      HTMLTextAreaElement,
    )
    await waitFor(() => expect(composer.value).toBe('Rewrite this request'))
    expect(document.activeElement).toBe(composer)
  })
})

function renderComposer(
  onSend: (text: string, attachments: string[]) => void,
  overrides: Partial<Parameters<typeof Composer>[0]> = {},
) {
  let currentOverrides = overrides
  const transport = overrides.transport ?? createResourceTransport()
  const composer = () => (
    <Composer
      transport={transport}
      provider="codex"
      projects={[{ path: '/work/harness', name: 'TasteCode', sessions: [] }]}
      projectPath="/work/harness"
      projectName="TasteCode"
      branch="main"
      branches={['main']}
      models={[]}
      modelsLoaded
      modelId={undefined}
      effort={undefined}
      serviceTier={undefined}
      approval="ask"
      autoReviewSupported={false}
      attachmentsSupported
      voiceAvailable={false}
      disabled={false}
      sendAvailability="ready"
      running={false}
      newSession
      isolate={false}
      designMode={false}
      focusRequest={0}
      queuedTurns={[]}
      canSteerQueue={false}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onServiceTierChange={vi.fn()}
      onApprovalChange={vi.fn()}
      onIsolateChange={vi.fn()}
      onDesignModeChange={vi.fn()}
      onTranscribeVoice={vi.fn()}
      onCancelVoice={vi.fn()}
      onProjectChange={vi.fn()}
      onBranchChange={vi.fn()}
      onProjectRequired={vi.fn()}
      onSetupProvider={vi.fn()}
      onSend={onSend}
      onSteer={vi.fn()}
      onInterrupt={vi.fn()}
      onDeleteQueuedTurn={vi.fn()}
      onMoveQueuedTurn={vi.fn()}
      onSteerQueuedTurn={vi.fn()}
      composerBridge={bridge}
      {...currentOverrides}
    />
  )
  const view = render(composer())
  return Object.assign(view, {
    rerenderComposer(next: Partial<Parameters<typeof Composer>[0]>) {
      currentOverrides = { ...currentOverrides, ...next }
      view.rerender(composer())
    },
  })
}

function createResourceTransport(
  request: TestRequestResolver = async (method) => {
    if (method === 'skills.list') {
      return {
        capabilities: { inventory: true, configure: true, install: true },
        skills: [],
        errors: [],
      }
    }
    if (method === 'mcp.list') {
      return {
        capabilities: {
          inventory: true,
          add: true,
          update: true,
          remove: true,
          reload: true,
          startOAuth: true,
          cancelOAuth: true,
        },
        servers: [],
      }
    }
    throw new Error(`Unexpected request: ${method}`)
  },
): TestTransport {
  return new TestTransport(request)
}

function populatedResourceTransport(): TestTransport {
  return createResourceTransport(async (method) => {
    if (method === 'skills.list') {
      return {
        capabilities: { inventory: true, configure: true, install: true },
        skills: [
          {
            id: '/skills/airtable-cli/SKILL.md',
            name: 'airtable-cli',
            displayName: 'Airtable CLI',
            description: 'Inspect Airtable bases, schemas, and records',
            source: { type: 'folder', path: '/skills/airtable-cli/SKILL.md' },
            scope: 'project',
            enabled: true,
            dependencyErrors: [],
          },
        ],
        errors: [],
      }
    }
    if (method === 'mcp.list') {
      return {
        capabilities: {
          inventory: true,
          add: true,
          update: true,
          remove: true,
          reload: true,
          startOAuth: true,
          cancelOAuth: true,
        },
        servers: [
          {
            id: 'officialDocs',
            displayName: 'Official Docs',
            description: 'Search official product documentation',
            scope: 'project',
            enabled: true,
            auth: { status: 'not_required' },
            startup: { state: 'ready' },
            tools: [],
            resources: [],
            resourceTemplates: [],
          },
        ],
      }
    }
    throw new Error(`Unexpected request: ${method}`)
  })
}
