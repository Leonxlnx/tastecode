import { createRequire } from 'node:module'

export type { SQLInputValue, StatementSync } from 'node:sqlite'
export type DatabaseSync = import('node:sqlite').DatabaseSync

function loadSqlite(): typeof import('node:sqlite') {
  const emitWarning = process.emitWarning
  // SQLite is an intentional dependency. Filter only its import-time notice,
  // and restore the warning handler before any application code can run.
  process.emitWarning = (warning, ...args) => {
    if (
      warning === 'SQLite is an experimental feature and might change at any time' &&
      args[0] === 'ExperimentalWarning'
    ) {
      return
    }
    Reflect.apply(emitWarning, process, [warning, ...args])
  }
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  } finally {
    process.emitWarning = emitWarning
  }
}

export const { DatabaseSync } = loadSqlite()
