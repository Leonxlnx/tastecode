import { DatabaseSync } from 'node:sqlite'
import { afterAll, bench, describe } from 'vitest'
import { BackgroundModelPreferenceSchema, SidebarSettingsSchema } from '@harness/contracts'
import { Store } from './store.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const READS = 10_000
const database = new DatabaseSync(':memory:')
database.exec(`
  CREATE TABLE sidebar_settings (
    id INTEGER PRIMARY KEY,
    mode TEXT NOT NULL,
    auto_settle_days INTEGER
  );
  INSERT INTO sidebar_settings VALUES (1, 'classic', 3);
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO app_settings VALUES (
    'background-model',
    '{"mode":"manual","target":{"provider":"codex","model":"gpt-5.6-luna","effort":"medium"}}'
  );
`)
const store = new Store(':memory:')
store.sidebarSettings()
store.updateBackgroundModelPreference({
  mode: 'manual',
  target: { provider: 'codex', model: 'gpt-5.6-luna', effort: 'medium' },
})

afterAll(() => {
  database.close()
  store.close()
})

function legacySidebarSettings() {
  const row = database
    .prepare(`SELECT mode, auto_settle_days FROM sidebar_settings WHERE id = 1`)
    .get() as { mode: string; auto_settle_days: number }
  return SidebarSettingsSchema.parse({ mode: row.mode, autoSettleDays: row.auto_settle_days })
}

function legacyBackgroundPreference() {
  const row = database
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get('background-model') as { value: string }
  return BackgroundModelPreferenceSchema.parse(JSON.parse(row.value))
}

describe('repeated settings reads', () => {
  bench(
    'prepares, reads, and validates sidebar settings 10,000 times',
    () => {
      for (let index = 0; index < READS; index += 1) legacySidebarSettings()
    },
    OPTIONS,
  )

  bench(
    'reuses sidebar settings 10,000 times',
    () => {
      for (let index = 0; index < READS; index += 1) store.sidebarSettings()
    },
    OPTIONS,
  )

  bench(
    'prepares, reads, parses, and validates background settings 10,000 times',
    () => {
      for (let index = 0; index < READS; index += 1) legacyBackgroundPreference()
    },
    OPTIONS,
  )

  bench(
    'reuses background settings 10,000 times',
    () => {
      for (let index = 0; index < READS; index += 1) store.backgroundModelPreference()
    },
    OPTIONS,
  )
})
