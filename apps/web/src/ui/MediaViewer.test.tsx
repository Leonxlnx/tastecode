// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MediaViewer } from './MediaViewer.js'

describe('MediaViewer image zoom', () => {
  it('scales the fitted image dimensions instead of an empty viewport-sized frame', () => {
    const { container } = render(
      <MediaViewer src="preview.png" name="preview.png" mediaType="image" onClose={vi.fn()} />,
    )
    const viewport = container.ownerDocument.querySelector('.media-viewer__viewport')
    const frame = container.ownerDocument.querySelector('.media-viewer__frame')
    const image = screen.getByRole('img', { name: 'preview.png' })
    expect(viewport).toBeInstanceOf(HTMLDivElement)
    expect(frame).toBeInstanceOf(HTMLDivElement)
    expect(image).toBeInstanceOf(HTMLImageElement)
    if (!(viewport instanceof HTMLDivElement) || !(frame instanceof HTMLDivElement)) return
    if (!(image instanceof HTMLImageElement)) return

    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 400 },
      naturalHeight: { configurable: true, value: 200 },
    })
    fireEvent.load(image)

    expect(frame.dataset['sized']).toBe('true')
    expect(frame.style.width).toBe('400px')
    expect(frame.style.height).toBe('200px')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    expect(frame.style.width).toBe('500px')
    expect(frame.style.height).toBe('250px')
    expect(screen.getByText('125%')).toBeTruthy()
  })
})
