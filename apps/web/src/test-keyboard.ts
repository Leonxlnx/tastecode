import { vi } from 'vitest'

/** Happy DOM aliases AltGraph to Alt; Chromium tracks them separately. */
export function mockKeyboardModifierState(): void {
  const getModifierState = KeyboardEvent.prototype.getModifierState
  vi.spyOn(KeyboardEvent.prototype, 'getModifierState').mockImplementation(function (
    this: KeyboardEvent,
    key,
  ) {
    return key === 'AltGraph' ? false : getModifierState.call(this, key)
  })
}
