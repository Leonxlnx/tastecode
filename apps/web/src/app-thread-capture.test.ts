import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Where a function nested in App uses App's snapshot of the focused chat (the
 * result of subscribing to the frame store's structure). V8 keeps a variable
 * that any closure of a render uses in that render's context, and each
 * callback App memoizes keeps its render's context: one such use kept the
 * transcript of a chat shown long ago (19 MB of one closed chat in a measured
 * session) for as long as any of those callbacks.
 *
 * Identifiers are resolved to the declaration they name, scope by scope, so a
 * shadowing declaration only hides the snapshot where it is in scope.
 */
function nestedUses(text: string): string[] {
  const tree = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let app: ts.FunctionDeclaration | undefined
  const find = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'App') app = node
    else ts.forEachChild(node, find)
  }
  find(tree)
  const body = app?.body
  if (!body) throw new Error('App is not a function declaration any more')

  const snapshots = body.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.filter(isStructureSnapshot)
      : [],
  )
  if (snapshots.length !== 1) {
    throw new Error(`App should hold one frame store structure snapshot, found ${snapshots.length}`)
  }
  const snapshot = snapshots[0]!
  const watched = new Set<ts.Node>([snapshot])
  // A value taken from the snapshot's items (a message, a list of them) keeps
  // transcript data alive the same way. An item's id or a count does not.
  const isSnapshot = (node: ts.Expression) =>
    ts.isIdentifier(node) && resolveName(node, body) === snapshot
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer && takesItems(declaration.initializer, isSnapshot)) {
        watched.add(declaration)
      }
    }
  }

  const uses: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isTypeNode(node)) return
    if (ts.isIdentifier(node) && isReference(node)) {
      const declaration = resolveName(node, body)
      if (declaration && watched.has(declaration) && insideNestedFunction(node, body)) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree))
        uses.push(`App.tsx:${line + 1} ${node.text}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return uses
}

/** Whether a value can be the snapshot itself or something read out of its `items`. */
function takesItems(value: ts.Expression, isSnapshot: (node: ts.Expression) => boolean): boolean {
  if (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isNonNullExpression(value)
  ) {
    return takesItems(value.expression, isSnapshot)
  }
  if (ts.isConditionalExpression(value)) {
    return takesItems(value.whenTrue, isSnapshot) || takesItems(value.whenFalse, isSnapshot)
  }
  if (ts.isBinaryExpression(value)) {
    const operator = value.operatorToken.kind
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken)
      return takesItems(value.right, isSnapshot)
    if (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return takesItems(value.left, isSnapshot) || takesItems(value.right, isSnapshot)
    }
    return false
  }
  if (isSnapshot(value)) return true
  if (ts.isPropertyAccessExpression(value) && ['id', 'length'].includes(value.name.text)) {
    return false
  }
  // Down the chain of calls and reads to where it starts.
  for (let node: ts.Expression = value; ;) {
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'items' && isSnapshot(node.expression)) return true
      node = node.expression
    } else if (ts.isCallExpression(node) || ts.isElementAccessExpression(node)) {
      node = node.expression
    } else if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) {
      node = node.expression
    } else {
      return false
    }
  }
}

/** `useSyncExternalStore(store.subscribeStructure, store.getStructureSnapshot)`, whatever its name. */
function isStructureSnapshot(declaration: ts.VariableDeclaration): boolean {
  const call = declaration.initializer
  return (
    ts.isIdentifier(declaration.name) &&
    call !== undefined &&
    ts.isCallExpression(call) &&
    call.expression.getText().endsWith('useSyncExternalStore') &&
    call.arguments.some(
      (argument) =>
        ts.isPropertyAccessExpression(argument) && argument.name.text === 'getStructureSnapshot',
    )
  )
}

/** An identifier that reads a value: not a property name, a key, a label or a new binding. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node
  // `{ thread }` reads the value of `thread`.
  if (ts.isShorthandPropertyAssignment(parent)) return true
  if (ts.isBindingElement(parent)) return parent.initializer === node
  if (
    ts.isQualifiedName(parent) ||
    ts.isJsxAttribute(parent) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakOrContinueStatement(parent)
  ) {
    return false
  }
  // Declarations, property keys and members name something new.
  return (parent as { name?: ts.Node }).name !== node
}

function insideNestedFunction(node: ts.Node, body: ts.Block): boolean {
  for (let current = node.parent; current && current !== body; current = current.parent) {
    if (ts.isFunctionLike(current)) return true
  }
  return false
}

/** The declaration `node` names, from the innermost scope that declares it, inside App. */
function resolveName(node: ts.Identifier, body: ts.Block): ts.Node | undefined {
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    const declaration = declaredIn(scope, node.text)
    if (declaration) return declaration
    if (scope === body) return undefined
  }
  return undefined
}

function declaredIn(scope: ts.Node, name: string): ts.Node | undefined {
  if (ts.isBlock(scope) || ts.isCaseBlock(scope) || ts.isSourceFile(scope)) {
    const statements = ts.isCaseBlock(scope)
      ? scope.clauses.flatMap((clause) => [...clause.statements])
      : [...scope.statements]
    for (const statement of statements) {
      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.flags & ts.NodeFlags.BlockScoped
      ) {
        for (const declaration of statement.declarationList.declarations) {
          const found = bindingIn(declaration.name, name, declaration)
          if (found) return found
        }
      }
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name?.text === name
      ) {
        return statement
      }
    }
    return undefined
  }
  if (ts.isFunctionLike(scope)) {
    if (ts.isFunctionExpression(scope) && scope.name?.text === name) return scope
    for (const parameter of scope.parameters) {
      const found = bindingIn(parameter.name, name, parameter)
      if (found) return found
    }
    return hoistedVar(scope, name)
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    return bindingIn(scope.variableDeclaration.name, name, scope.variableDeclaration)
  }
  if (
    (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    scope.initializer &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    for (const declaration of scope.initializer.declarations) {
      const found = bindingIn(declaration.name, name, declaration)
      if (found) return found
    }
  }
  return undefined
}

function bindingIn(binding: ts.BindingName, name: string, owner: ts.Node): ts.Node | undefined {
  if (ts.isIdentifier(binding)) return binding.text === name ? owner : undefined
  for (const element of binding.elements) {
    if (ts.isOmittedExpression(element)) continue
    const found = bindingIn(element.name, name, element)
    if (found) return found
  }
  return undefined
}

/** A `var` anywhere in a function's own body belongs to the whole function. */
function hoistedVar(fn: ts.SignatureDeclaration, name: string): ts.Node | undefined {
  let found: ts.Node | undefined
  const visit = (node: ts.Node) => {
    if (found || (node !== fn && ts.isFunctionLike(node))) return
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) {
      for (const declaration of node.declarations) {
        found ??= bindingIn(declaration.name, name, declaration)
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(fn, visit)
  return found
}

const app = (...lines: string[]) =>
  [
    'export function App() {',
    '  const thread = useSyncExternalStore(store.subscribeStructure, store.getStructureSnapshot)',
    ...lines,
    '  return null',
    '}',
  ].join('\n')

describe('App closures', () => {
  it('never use the focused chat snapshot, so no memoized callback keeps a closed chat', () => {
    const text = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')
    expect(nestedUses(text)).toEqual([])
  })

  it('finds a use inside a callback, but not a shadowing one or a render-level one', () => {
    const uses = nestedUses(
      app(
        '  const running = thread.running',
        '  const later = () => thread.items',
        '  const own = (thread: State) => thread.items',
        '  const listed = () => ({ thread })',
      ),
    )
    expect(uses).toEqual(['App.tsx:4 thread', 'App.tsx:6 thread'])
  })

  it('lets a block-local declaration hide the snapshot only inside its block', () => {
    const uses = nestedUses(
      app(
        '  const later = () => {',
        '    if (flag) {',
        '      const thread = local',
        '      consume(thread)',
        '    }',
        '    return thread.items',
        '  }',
      ),
    )
    expect(uses).toEqual(['App.tsx:8 thread'])
  })

  it('follows the snapshot under another name, and fails when App has none', () => {
    const renamed = [
      'export function App() {',
      '  const frame = useSyncExternalStore(column.subscribeStructure, column.getStructureSnapshot)',
      '  const later = () => frame.items',
      '  return null',
      '}',
    ].join('\n')
    expect(nestedUses(renamed)).toEqual(['App.tsx:3 frame'])
    expect(() =>
      nestedUses('export function App() {\n  const thread = read()\n  return null\n}'),
    ).toThrow('found 0')
  })

  it('counts a message taken from the items, but not an item id or a count', () => {
    const uses = nestedUses(
      app(
        '  const request = thread.error ? thread.items.findLast(isUser) : undefined',
        '  const requestId = thread.items.findLast(isUser)?.id',
        '  const count = thread.items.length',
        '  const resume = () => schedule(request, requestId, count)',
      ),
    )
    expect(uses).toEqual(['App.tsx:6 request'])
  })

  it('does not count an unrelated method or property called thread', () => {
    const uses = nestedUses(
      app(
        '  const api = { thread() { return 1 }, run: () => api.thread() }',
        '  const options = { thread: 1 }',
      ),
    )
    expect(uses).toEqual([])
  })
})
