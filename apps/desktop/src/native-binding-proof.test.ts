import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertPackagedDesignReferences,
  assertPackagedNativeModules,
  proveKeyringBinding,
  provePtyBinding,
} from './native-binding-proof.js'

const fixtures: string[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function referenceFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'packaged-reference-proof-'))
  fixtures.push(root)
  const archive = path.join(root, 'app.asar')
  const packageRoot = path.join(archive, 'node_modules', '@harness', 'design-agent')
  const references = path.join(packageRoot, 'references', 'directions', 'product')
  mkdirSync(references, { recursive: true })
  return {
    proof: path.join(archive, 'dist', 'native-binding-proof.js'),
    entry: path.join(packageRoot, 'dist', 'index.js'),
    image: path.join(references, 'product.webp'),
  }
}

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
  it('requires packaged reference files with WebP signatures', () => {
    const fixture = referenceFixture()
    expect(() => assertPackagedDesignReferences(fixture.proof, fixture.entry)).toThrow('missing')
    writeFileSync(fixture.image, 'not a WebP image')
    expect(() => assertPackagedDesignReferences(fixture.proof, fixture.entry)).toThrow('invalid')
    writeFileSync(
      fixture.image,
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),
    )
    expect(assertPackagedDesignReferences(fixture.proof, fixture.entry)).toBe(1)
    expect(() =>
      assertPackagedDesignReferences(fixture.proof, path.resolve('dist', 'index.js')),
    ).toThrow('inside the packaged application')
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
