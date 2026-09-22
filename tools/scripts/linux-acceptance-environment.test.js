import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { acceptanceLaunchEnvironment } from './linux-acceptance-environment.js'

test('isolates both XDG storage and the TasteCode server configuration', () => {
  const profile = path.join(os.tmpdir(), 'tastecode-linux-acceptance-test')

  assert.deepEqual(acceptanceLaunchEnvironment(profile), {
    XDG_CONFIG_HOME: path.join(profile, 'config'),
    XDG_DATA_HOME: path.join(profile, 'data'),
    XDG_STATE_HOME: path.join(profile, 'state'),
    XDG_CACHE_HOME: path.join(profile, 'cache'),
    HARNESS_CONFIG_DIR: path.join(profile, 'server-config'),
  })
})
