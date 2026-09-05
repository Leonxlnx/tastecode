// @vitest-environment happy-dom
import { Suspense } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LazyMediaViewer, preloadMediaViewer } from './LazyMediaViewer.js'

const moduleLoad = vi.hoisted(() => {
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return { ready, release }
})

vi.mock('./MediaViewer.js', async () => {
  await moduleLoad.ready
  return {
    MediaViewer: ({ name }: { name: string }) => <div role="dialog" aria-label={name} />,
  }
})

afterEach(cleanup)

it('opens on import completion without a Suspense reveal delay, then reopens synchronously', async () => {
  const props = {
    src: 'photo.png',
    name: 'photo.png',
    mediaType: 'image' as const,
    onClose: vi.fn(),
  }
  preloadMediaViewer()
  const view = render(
    <Suspense fallback={<span>Waiting for viewer</span>}>
      <LazyMediaViewer {...props} />
    </Suspense>,
  )
  expect(screen.queryByText('Waiting for viewer')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()

  await act(async () => {
    moduleLoad.release()
    await vi.dynamicImportSettled()
  })
  expect(screen.getByRole('dialog', { name: props.name })).toBeTruthy()
  view.unmount()

  render(<LazyMediaViewer {...props} />)
  expect(screen.getByRole('dialog', { name: props.name })).toBeTruthy()
})
