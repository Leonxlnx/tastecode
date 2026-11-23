import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Uses of App's `thread` (the focused chat's whole state) inside a function
 * nested in App. V8 keeps a variable that any closure of a render uses in that
 * render's context, and each callback App memoizes keeps its render's context:
 * one such use kept the transcript of a chat shown long ago (19 MB of one
 * closed chat in a measured session) for as long as any of those callbacks.
 */
function nestedUses(text: string, variable: string): string[] {
  const tree = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let app: ts.FunctionDeclaration | undefined
  const find = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'App') app = node
    else ts.forEachChild(node, find)
  }
  find(tree)
  if (!app?.body) throw new Error('App is not a function declaration any more')

  const uses: string[] = []
  const declares = (fn: ts.SignatureDeclaration) => {
    let found = false
    const visit = (node: ts.Node) => {
      if (found || (node !== fn && ts.isFunctionLike(node))) return
      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === variable
      )
        found = true
      else ts.forEachChild(node, visit)
    }
    ts.forEachChild(fn, visit)
    return found
  }
  const visit = (node: ts.Node, nested: boolean) => {
    if (ts.isFunctionLike(node)) {
      if (declares(node)) return
      nested = true
    }
    if (ts.isTypeNode(node)) return
    if (ts.isIdentifier(node) && node.text === variable && nested) {
      const parent = node.parent
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node) ||
        ts.isJsxAttribute(parent)
      if (!isName) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree))
        uses.push(`App.tsx:${line + 1}`)
      }
    }
    ts.forEachChild(node, (child) => visit(child, nested))
  }
  ts.forEachChild(app.body, (child) => visit(child, false))
  return uses
}

describe('App closures', () => {
  it('never use the focused chat state, so no memoized callback keeps a closed chat', () => {
    const text = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')
    expect(nestedUses(text, 'thread')).toEqual([])
  })

  it('finds a use inside a callback, but not a shadowing one or a render-level one', () => {
    const uses = nestedUses(
      [
        'export function App() {',
        '  const thread = read()',
        '  const running = thread.running',
        '  const later = () => thread.items',
        '  const own = (thread: State) => thread.items',
        '  return <Row running={running} later={later} own={own} />',
        '}',
      ].join('\n'),
      'thread',
    )
    expect(uses).toEqual(['App.tsx:4'])
  })
})
