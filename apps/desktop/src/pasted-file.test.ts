import { describe, expect, it } from 'vitest'
import { MAX_PASTED_FILE_BYTES, pastedFile } from './pasted-file.js'

describe('pastedFile', () => {
  it('materializes ordinary files with a safe leaf name', () => {
    const file = pastedFile({
      name: '..\\..\\report?.pdf',
      type: 'application/pdf',
      bytes: new TextEncoder().encode('%PDF-1.7'),
    })

    expect(file.name).toBe('report-.pdf')
    expect(file.bytes.toString()).toBe('%PDF-1.7')
  })

  it('keeps image magic-byte validation', () => {
    expect(() =>
      pastedFile({ name: 'fake.png', type: 'image/png', bytes: new Uint8Array([1, 2, 3]) }),
    ).toThrow('Unsupported pasted image')
  })

  it('rejects files above the bounded clipboard bridge limit', () => {
    expect(() =>
      pastedFile({
        name: 'movie.mp4',
        type: 'video/mp4',
        bytes: new Uint8Array(MAX_PASTED_FILE_BYTES + 1),
      }),
    ).toThrow('larger than 25 MB')
  })
})
