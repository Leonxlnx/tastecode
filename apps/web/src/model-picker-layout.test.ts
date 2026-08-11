// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MODEL_PICKER_LAYOUT_KEY,
  readModelPickerLayout,
  subscribeModelPickerLayout,
  writeModelPickerLayout,
} from './model-picker-layout.js'

afterEach(() => {
  vi.restoreAllMocks()
  writeModelPickerLayout('list')
  localStorage.clear()
})

describe('model picker layout preference', () => {
  it('keeps the new session value when persistent storage rejects the write', () => {
    localStorage.setItem(MODEL_PICKER_LAYOUT_KEY, 'list')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })
    const onChange = vi.fn()
    const unsubscribe = subscribeModelPickerLayout(onChange)

    writeModelPickerLayout('rail')

    expect(localStorage.getItem(MODEL_PICKER_LAYOUT_KEY)).toBe('list')
    expect(readModelPickerLayout()).toBe('rail')
    expect(onChange).toHaveBeenCalledOnce()
    unsubscribe()
  })
})
