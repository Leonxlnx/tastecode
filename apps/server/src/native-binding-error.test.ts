import { describe, expect, it } from 'vitest'
import { isAsarRuntime, rethrowNativeBindingFailure } from './native-binding-error.js'

describe('isAsarRuntime', () => {
  it('detects a module loaded from inside app.asar', () => {
    expect(
      isAsarRuntime(
        'file:///opt/Taste%20Code/resources/app.asar/node_modules/@harness/server/dist/terminal.js',
      ),
    ).toBe(true)
    expect(
      isAsarRuntime(
        'C:\\Taste Code\\resources\\app.asar\\node_modules\\x\\y.js'.replaceAll('\\', '/'),
      ),
    ).toBe(true)
  })

  it('is false for a development module path', () => {
    expect(isAsarRuntime('file:///repo/apps/server/dist/terminal.js')).toBe(false)
  })
})

describe('rethrowNativeBindingFailure', () => {
  const cause = new Error("Cannot find module './prebuilds/linux-x64/pty.node'")

  it('turns a packaged load failure into restart-or-reinstall advice', () => {
    expect(() => rethrowNativeBindingFailure(cause, 'the terminal PTY binding', true)).toThrowError(
      /terminal PTY binding could not be loaded; the installation on disk changed or is incomplete\. Restart the app, and reinstall it if the problem persists\./,
    )
  })

  it('keeps the original error as the cause', () => {
    try {
      rethrowNativeBindingFailure(cause, 'the OS credential store binding', true)
      expect.unreachable()
    } catch (error) {
      expect((error as { cause?: unknown }).cause).toBe(cause)
    }
  })

  it('rethrows the original error outside a packaged runtime', () => {
    expect(() =>
      rethrowNativeBindingFailure(cause, 'the terminal PTY binding', false),
    ).toThrowError(cause)
  })
})
