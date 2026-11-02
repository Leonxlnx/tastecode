import { defineConfig } from 'vitest/config'

// The phone's protocol logic runs under Node; anything native is mocked per test.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
