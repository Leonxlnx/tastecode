// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Pencil } from 'lucide-react'
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
    if (this.classList.contains('menu')) {
      return rect(0, 0, this.classList.contains('is-positioned') ? 252 : 260, 138)
    }
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
          {(close) => <MenuItem icon={Pencil} title="Rename" onClick={close} />}
        </Menu>
      </div>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))

    const menu = screen.getByRole('menu')
    expect(screen.getByTestId('clip').contains(menu)).toBe(false)
    expect(menu.parentElement).toBe(document.body)
    expect(menu.classList.contains('menu--up')).toBe(true)
    expect(menu.style.left).toBe('32px')
    expect(menu.style.top).toBe('')
    expect(menu.style.bottom).toBe('36px')
    expect(menu.querySelector('.menu__icon')).toBeTruthy()

    fireEvent.mouseDown(menu)
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('centers a menu on small screens when requested', () => {
    render(
      <Menu centerOnSmallScreens drop="down" label="Options" trigger={() => <span>Open</span>}>
        {(close) => <MenuItem icon={Pencil} title="Rename" onClick={close} />}
      </Menu>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))

    const menu = screen.getByRole('menu')
    Object.defineProperties(menu, {
      offsetWidth: { configurable: true, value: 260 },
      offsetHeight: { configurable: true, value: 142 },
    })
    fireEvent(window, new Event('resize'))

    expect(menu.style.left).toBe('20px')
  })
})
