import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The contracts root entry evaluates the whole protocol: every message schema is built when it
 * loads. Startup modules take their few runtime values from `@harness/contracts/ids` instead, and
 * the full schemas arrive with the lazy `transport-validation` chunk.
 *
 * This walks the static import graph from `main.tsx` (relative imports only; `import()` is a
 * lazy boundary and is not followed) and fails when a reachable module imports anything at run
 * time from the root entry. `import type` is allowed; `import { type A }` is not, because under
 * `verbatimModuleSyntax` it stays an import of the module. It cannot see what the bundler does on
 * its own: imports through packages other than contracts, Vite aliases or plugins, or a lazy
 * chunk that the bundler merges into the startup chunk.
 */
const src = dirname(fileURLToPath(import.meta.url))
const ALLOWED_RUNTIME_ENTRIES = new Set(['@harness/contracts/ids'])

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier)
  const stem = base.replace(/\.(?:js|jsx|mjs)$/, '')
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, join(stem, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

function runtimeContractImports(entry: string) {
  const seen = new Set<string>()
  const offenders: string[] = []
  const queue = [entry]
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue
    seen.add(file)
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
    for (const statement of source.statements) {
      let specifier: string
      let typeOnly: boolean
      if (ts.isImportDeclaration(statement)) {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
        specifier = statement.moduleSpecifier.text
        typeOnly = statement.importClause?.isTypeOnly ?? false
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
        specifier = statement.moduleSpecifier.text
        typeOnly = statement.isTypeOnly
      } else {
        continue
      }
      if (typeOnly) continue
      if (specifier.startsWith('@harness/contracts')) {
        if (!ALLOWED_RUNTIME_ENTRIES.has(specifier)) {
          offenders.push(`${relative(src, file).replaceAll('\\', '/')} -> ${specifier}`)
        }
      } else if (specifier.startsWith('.')) {
        const resolved = resolveRelative(file, specifier)
        if (resolved) queue.push(resolved)
      }
    }
  }
  return { reached: seen.size, offenders }
}

describe('startup imports from the contracts', () => {
  it('take no runtime value from the protocol before the validation chunk loads', () => {
    const { reached, offenders } = runtimeContractImports(join(src, 'main.tsx'))
    // Guards the walk itself: a broken resolver would pass with an empty graph.
    expect(reached).toBeGreaterThan(50)
    expect(offenders).toEqual([])
  })
})
