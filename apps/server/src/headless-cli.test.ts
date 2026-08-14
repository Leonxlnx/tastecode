import { describe, expect, it } from 'vitest'
import { parseCliOptions } from './headless-cli.js'

describe('headless CLI', () => {
  it('parses the serve command and listener port', () => {
    expect(parseCliOptions(['serve', '--port', '4400'])).toEqual({
      command: 'serve',
      port: 4400,
    })
  })

  it('uses the environment port and rejects invalid arguments', () => {
    expect(parseCliOptions(['serve'], { HARNESS_PORT: '5500' })).toEqual({
      command: 'serve',
      port: 5500,
    })
    expect(() => parseCliOptions(['pair'])).toThrow('Unknown argument: pair')
    expect(() => parseCliOptions(['--port', '70000'])).toThrow('between 1 and 65535')
  })
})
