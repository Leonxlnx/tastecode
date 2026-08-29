import { describe, expect, it, vi } from 'vitest'
import {
  assertPackagedNativeModules,
  isNativeBindingProofPlatform,
  proveKeyringBinding,
  provePtyBinding,
} from './native-binding-proof.js'

function fakePty() {
  const resize = vi.fn()
  const kill = vi.fn()
  return {
    resize,
    kill,
    module: {
      spawn: vi.fn((_file: string, _args: string[]) => {
        let onData: (data: string) => void = () => {}
        let onExit: (event: { exitCode: number }) => void = () => {}
        queueMicrotask(() => {
          onData('TASTECODE_NATIVE_PTY_OK')
          onExit({ exitCode: 0 })
        })
        return {
          onData(listener: (data: string) => void) {
            onData = listener
            return { dispose: vi.fn() }
          },
          onExit(listener: (event: { exitCode: number }) => void) {
            onExit = listener
            return { dispose: vi.fn() }
          },
          resize,
          kill,
        }
      }),
    },
  }
}

describe('packaged native binding proof', () => {
  it('qualifies the three desktop release platforms', () => {
    expect(isNativeBindingProofPlatform('win32')).toBe(true)
    expect(isNativeBindingProofPlatform('darwin')).toBe(true)
    expect(isNativeBindingProofPlatform('linux')).toBe(true)
    expect(isNativeBindingProofPlatform('freebsd')).toBe(false)
  })

  it('requires module entries and both bindings from the packaged archive', () => {
    expect(() =>
      assertPackagedNativeModules('C:\\Taste Code\\resources\\app.asar\\dist\\proof.js', {
        moduleEntries: [
          'C:\\Taste Code\\resources\\app.asar\\node_modules\\node-pty\\lib\\index.js',
          'C:\\Taste Code\\resources\\app.asar\\node_modules\\@napi-rs\\keyring\\index.js',
        ],
        nativeBindings: [
          'C:\\Taste Code\\resources\\app.asar.unpacked\\node_modules\\node-pty\\build\\pty.node',
          'C:\\Taste Code\\resources\\app.asar.unpacked\\node_modules\\@napi-rs\\keyring-win32-x64-msvc\\keyring.node',
        ],
      }),
    ).not.toThrow()
  })

  it('spawns, resizes, and observes a clean PTY exit', async () => {
    const pty = fakePty()
    await expect(provePtyBinding(pty.module, 'win32')).resolves.toBeUndefined()
    expect(pty.module.spawn).toHaveBeenCalledOnce()
    expect(pty.resize).toHaveBeenCalledWith(100, 30)
    expect(pty.kill).toHaveBeenCalledOnce()
  })

  it('writes, reads, deletes, and verifies an isolated credential', () => {
    const credentials = new Map<string, string>()
    class Entry {
      constructor(
        private readonly service: string,
        private readonly account: string,
      ) {}
      private key() {
        return `${this.service}:${this.account}`
      }
      getPassword() {
        return credentials.get(this.key()) ?? null
      }
      setPassword(value: string) {
        credentials.set(this.key(), value)
      }
      deletePassword() {
        credentials.delete(this.key())
      }
    }

    proveKeyringBinding({ Entry })
    expect(credentials.size).toBe(0)
  })
})
