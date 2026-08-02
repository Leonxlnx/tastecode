// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Menu, MenuItem } from './Menu.js'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('menutrigger')) return rect(215, 170, 24, 24)
    if (this.classList.contains('menu')) return rect(0, 0, 260, 142)
    return rect(0, 0, 0, 0)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Menu', () => {
  it('escapes clipping containers and stays inside the viewport', () => {
    render(
      <div data-testid="clip">
        <Menu drop="down" align="right" label="Options" trigger={() => <span>Open</span>}>
          {(close) => <MenuItem title="Rename" onClick={close} />}
        </Menu>
      </div>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))

    const menu = screen.getByRole('menu')
    expect(screen.getByTestId('clip').contains(menu)).toBe(false)
    expect(menu.parentElement).toBe(document.body)
    expect(menu.classList.contains('menu--up')).toBe(true)
    expect(menu.style.left).toBe('8px')
    expect(menu.style.top).toBe('')
    expect(menu.style.bottom).toBe('36px')

    fireEvent.mouseDown(menu)
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('does not reposition when its own content scrolls', () => {
    let menuWidth = 100
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      if (this.classList.contains('menutrigger')) return rect(215, 170, 24, 24)
      if (this.classList.contains('menu')) return rect(0, 0, menuWidth, 142)
      return rect(0, 0, 0, 0)
    })

    render(
      <Menu align="right" label="Models" trigger={() => <span>Open</span>}>
        {() => <div>Scrollable models</div>}
      </Menu>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))

    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('139px')
    menuWidth = 80
    fireEvent.scroll(menu)
    expect(menu.style.left).toBe('139px')
  })
})
