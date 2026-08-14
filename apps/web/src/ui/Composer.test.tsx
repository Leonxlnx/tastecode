// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { emptyThread, reduce } from '../thread-store.js'
import type { Transport } from '../transport.js'
import { Composer } from './Composer.js'

const bridge = vi.hoisted(() => ({
  pickFiles: vi.fn(),
  savePastedImage: vi.fn(),
}))

vi.mock('../bridge.js', () => ({
  pickFiles: bridge.pickFiles,
  savePastedImage: bridge.savePastedImage,
}))

beforeEach(() => {
  bridge.pickFiles.mockResolvedValue([])
  bridge.savePastedImage.mockResolvedValue('/tmp/pasted-image.png')
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
      () =>
        ({
          x: 100,
          y: top,
          top,
          right: 720,
          bottom: top + 120,
          left: 100,
          width: 620,
          height: 120,
          toJSON: () => ({}),
        }) as DOMRect,
    )

    const animation = {
      id: '',
      cancel: vi.fn(),
      finished: new Promise<void>(() => undefined),
    } as unknown as Animation
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

describe('Composer image paste', () => {
  it('previews a pasted image and sends its materialized path', async () => {
    const onSend = vi.fn()
    renderComposer(onSend)
    const composer = screen.getByPlaceholderText('Do anything')
    const image = new File(['image bytes'], 'Screenshot.png', { type: 'image/png' })

    fireEvent.paste(composer, { clipboardData: { files: [image] } })

    expect(screen.getByRole('button', { name: 'Open Screenshot.png' })).toBeTruthy()
    expect(bridge.savePastedImage).toHaveBeenCalledWith(image)
    fireEvent.change(composer, { target: { value: 'What is in this image?' } })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
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
    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
    const image = new File(['image bytes'], 'Screenshot.png', { type: 'image/png' })
    fireEvent.change(composer, { target: { value: 'Keep this draft' } })

    fireEvent.paste(composer, { clipboardData: { files: [image] } })

    expect(bridge.savePastedImage).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Open Screenshot.png' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(
      'Attachments aren’t supported by this source.',
    )
    expect(composer.value).toBe('Keep this draft')
  })
})

describe('Composer attachment source switching', () => {
  it('keeps existing attachments removable but blocks sending them through an unsupported source', async () => {
    bridge.pickFiles.mockResolvedValue(['/work/reference.txt'])
    const onSend = vi.fn()
    const view = renderComposer(onSend)
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
    expect(await screen.findByText('reference.txt')).toBeTruthy()

    view.rerenderComposer({ attachmentsSupported: false })
    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'Keep this with the attachment' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()
    expect(composer.value).toBe('Keep this with the attachment')
    expect(screen.getByText('reference.txt')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove reference.txt' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
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
})

describe('Composer queue', () => {
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
    expect((screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement).value).toBe(
      'Polish the queue',
    )
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

  it('sends slash-prefixed text without offering built-in commands', () => {
    const onSend = vi.fn()
    renderComposer(onSend)

    expect(screen.queryByText('Commands')).toBeNull()
    expect(screen.queryByText('/review')).toBeNull()

    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: '/review' } })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('/review', [])
  })

  it('opens skills and MCP servers from dollar and selects the active row with Tab', async () => {
    const onSend = vi.fn()
    const transport = populatedResourceTransport()
    renderComposer(onSend, { transport })
    const composer = screen.getByPlaceholderText('Do anything')

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
    expect((composer as HTMLTextAreaElement).value).toBe('')
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
          capabilities: { inventory: true },
          servers: [{ id: 'global-docs', scope: 'global', enabled: true }],
        }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    renderComposer(vi.fn(), { transport })
    const composer = screen.getByPlaceholderText('Do anything')

    fireEvent.change(composer, { target: { value: '$', selectionStart: 1 } })

    await waitFor(() => expect(transport.request).toHaveBeenCalledTimes(2))
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
    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement

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
    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
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
})

describe('Composer draft replacement', () => {
  it('loads a previous prompt for editing and focuses it', async () => {
    renderComposer(vi.fn(), {
      draftRequest: { text: 'Rewrite this request', request: 1 },
    })

    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
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
      projects={[{ path: '/work/harness', name: 'Harness', sessions: [] }]}
      projectPath="/work/harness"
      projectName="Harness"
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
  request: (method: string, params: unknown) => Promise<unknown> = async (method) => {
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
): Transport {
  return {
    state: 'open',
    request: vi.fn(request),
    on: vi.fn(() => () => undefined),
    onState: vi.fn(() => () => undefined),
  } as unknown as Transport
}

function populatedResourceTransport(): Transport {
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
