// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
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

function ContextMenuHarness() {
  const target = useRef<HTMLButtonElement>(null)

  return (
    <>
      <button ref={target}>Project row</button>
      <Menu
        drop="down"
        label="Project options"
        contextMenuTargetRef={target}
        trigger={() => <span>Open</span>}
      >
        {(close) => (
          <MenuItem title="Rename" icon={<Pencil size={14} aria-hidden />} onClick={close} />
        )}
      </Menu>
    </>
  )
}

const focusElement = HTMLElement.prototype.focus

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.textContent === 'Project row') return rect(40, 60, 100, 20)
    if (this.classList.contains('menutrigger')) return rect(215, 170, 24, 24)
    if (this.classList.contains('menu')) return rect(0, 0, 260, 142)
    return rect(0, 0, 0, 0)
  })
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement) {
    if (this.closest<HTMLElement>('.menu')?.style.visibility === 'hidden') return
    focusElement.call(this)
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
          {(close) => (
            <MenuItem title="Rename" icon={<Pencil size={14} aria-hidden />} onClick={close} />
          )}
        </Menu>
      </div>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Options' }), { detail: 1 })

    const menu = screen.getByRole('menu')
    expect(screen.getByTestId('clip').contains(menu)).toBe(false)
    expect(menu.parentElement).toBe(document.body)
    expect(menu.classList.contains('menu--up')).toBe(true)
    expect(menu.style.left).toBe('8px')
    expect(menu.style.top).toBe('')
    expect(menu.style.bottom).toBe('36px')
    expect(menu.dataset.inputModality).toBe('pointer')
    expect(menu.style.transformOrigin).toBe('right bottom')

    fireEvent.mouseDown(menu)
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('honors a larger gap for a raised panel', () => {
    render(
      <Menu drop="up" gap={14} label="Account" trigger={() => <span>Account</span>}>
        {() => <div>Plan limits</div>}
      </Menu>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))

    expect(screen.getByRole('menu').style.bottom).toBe('44px')
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

  it('keeps a right-aligned panel fixed while its opening animation scales visual bounds', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      if (this.classList.contains('menutrigger')) return rect(350, 170, 70, 24)
      if (this.classList.contains('menu')) {
        return rect(0, 0, this.classList.contains('is-positioned') ? 248 : 260, 142)
      }
      return rect(0, 0, 0, 0)
    })

    render(
      <Menu align="right" label="Models" trigger={() => <span>Open</span>}>
        {() => <div>Animated models</div>}
      </Menu>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))

    const menu = screen.getByRole('menu')
    Object.defineProperties(menu, {
      offsetWidth: { configurable: true, value: 260 },
      offsetHeight: { configurable: true, value: 142 },
    })
    fireEvent(window, new Event('resize'))

    expect(menu.style.left).toBe('160px')
  })

  it('opens at the pointer when its context-menu target is right-clicked', () => {
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      if (this.textContent === 'Project row') return rect(40, 60, 100, 20)
      if (this.classList.contains('menutrigger')) return rect(215, 170, 24, 24)
      if (this.classList.contains('menu')) return rect(0, 0, 100, 80)
      return rect(0, 0, 0, 0)
    })
    render(<ContextMenuHarness />)

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Project row' }), {
      clientX: 120,
      clientY: 80,
    })

    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('120px')
    expect(menu.style.top).toBe('80px')
    expect(menu.dataset.inputModality).toBe('pointer')
    expect(menu.style.transformOrigin).toBe('left top')
    expect(
      screen.getByRole('button', { name: 'Project options' }).getAttribute('aria-expanded'),
    ).toBe('true')

    fireEvent.keyDown(menu, { key: 'Escape' })
    const target = screen.getByRole('button', { name: 'Project row' })
    fireEvent.keyDown(target, { key: 'F10', shiftKey: true })
    fireEvent.contextMenu(target, { clientX: 0, clientY: 0 })
    const keyboardMenu = screen.getByRole('menu')
    expect(keyboardMenu.dataset.inputModality).toBe('keyboard')
    expect(keyboardMenu.style.left).toBe('40px')
    expect(keyboardMenu.style.top).toBe('80px')
  })

  it('roves, typeaheads, selects, and restores focus after dismissals', () => {
    const onSelect = vi.fn()
    render(
      <>
        <Menu label="Actions" trigger={() => <span>Open</span>}>
          {(close) =>
            ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((title) => (
              <MenuItem
                key={title}
                title={title}
                icon={<Pencil size={14} aria-hidden />}
                disabled={title === 'Bravo'}
                onClick={() => {
                  onSelect(title)
                  if (title === 'Delta') close()
                }}
              />
            ))
          }
        </Menu>
        <button>Outside</button>
      </>,
    )

    const trigger = screen.getByRole('button', { name: 'Actions' })
    const outside = screen.getByRole('button', { name: 'Outside' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })

    const alpha = screen.getByRole('menuitem', { name: 'Alpha' })
    const bravo = screen.getByRole('menuitem', { name: 'Bravo' })
    const charlie = screen.getByRole('menuitem', { name: 'Charlie' })
    const delta = screen.getByRole('menuitem', { name: 'Delta' })
    expect(document.activeElement).toBe(alpha)
    expect((bravo as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('menu').dataset.inputModality).toBe('keyboard')

    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(charlie)

    fireEvent.keyDown(charlie, { key: 'd' })
    expect(document.activeElement).toBe(delta)
    fireEvent.keyDown(delta, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('Delta')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delta' }))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.mouseDown(outside)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Alpha' }), { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(outside)

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Alpha' }), {
      key: 'Tab',
      shiftKey: true,
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('contains Tab only inside dialog-style panels', () => {
    render(
      <Menu
        drop="down"
        label="Choose model"
        panelLabel="Models"
        panelRole="dialog"
        trigger={() => <span>Open</span>}
      >
        {() => (
          <>
            <button type="button">Apply</button>
            <input autoFocus aria-label="Filter models" />
          </>
        )}
      </Menu>,
    )

    fireEvent.keyDown(screen.getByRole('button', { name: 'Choose model' }), {
      key: 'ArrowDown',
    })
    const filter = screen.getByRole('textbox', { name: 'Filter models' })
    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(filter)

    fireEvent.keyDown(filter, { key: 'Tab' })
    expect(document.activeElement).toBe(apply)
    fireEvent.keyDown(apply, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(filter)
  })
})
