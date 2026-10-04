// @vitest-environment happy-dom
import { type ReactNode, useRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { bench, describe } from 'vitest'
import { Menu } from './Menu.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }

function ClosedMenuRow(props: { index: number }) {
  const target = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button ref={target}>Project {props.index}</button>
      <Menu
        label={`Project ${props.index} options`}
        contextMenuTargetRef={target}
        trigger={() => <span>Options</span>}
      >
        {() => <button type="button">Rename</button>}
      </Menu>
    </div>
  )
}

function ContextOnlyMenuRow(props: { index: number }) {
  const target = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button ref={target}>Project {props.index}</button>
      <Menu label={`Project ${props.index} options`} contextMenuTargetRef={target} contextMenuOnly>
        {() => <button type="button">Rename</button>}
      </Menu>
    </div>
  )
}

function TargetOnlyRow(props: { index: number }) {
  return (
    <div>
      <button>Project {props.index}</button>
    </div>
  )
}

function PlainTriggerRow(props: { index: number }) {
  return (
    <div>
      <button>Project {props.index}</button>
      <div className="menuwrap">
        <button type="button" className="menutrigger" aria-label={`Project ${props.index} options`}>
          <span>Options</span>
        </button>
      </div>
    </div>
  )
}

function mount(rows: ReactNode): void {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  flushSync(() => root.render(rows))
  flushSync(() => root.unmount())
  container.remove()
}

const menus = Array.from({ length: 100 }, (_, index) => <ClosedMenuRow key={index} index={index} />)
const contextMenus = Array.from({ length: 100 }, (_, index) => (
  <ContextOnlyMenuRow key={index} index={index} />
))
const targets = Array.from({ length: 100 }, (_, index) => (
  <TargetOnlyRow key={index} index={index} />
))
const triggers = Array.from({ length: 100 }, (_, index) => (
  <PlainTriggerRow key={index} index={index} />
))

describe('dormant project menu mount', () => {
  bench('mounts 100 closed Menu instances', () => mount(menus), OPTIONS)
  bench('mounts 100 context-only Menu instances', () => mount(contextMenus), OPTIONS)
  bench('mounts 100 context targets without Menu', () => mount(targets), OPTIONS)
  bench('mounts 100 equivalent plain triggers', () => mount(triggers), OPTIONS)
})
