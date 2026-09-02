import { strict as assert } from 'node:assert'

import {
  CancellationTokenSource,
  CodeActionKind,
  CodeActionTriggerKind,
  Location,
  Position,
  Range,
  WorkspaceEdit,
  workspace
} from 'vscode'

import type { CodeActionContext } from 'vscode'
import { ZeroReferenceCodeActionProvider } from '../src/codeActionProvider.js'
import { createAnalysisHarness } from './analysisHarness.js'

const context: CodeActionContext = {
  diagnostics: [],
  only: undefined,
  triggerKind: CodeActionTriggerKind.Invoke
}

suite('ZeroReferenceCodeActionProvider', () => {
  for (const newline of ['\n', '\r\n']) {
    test(`inserts before split declaration keywords with ${JSON.stringify(newline)}`, async () => {
      const content = ['namespace Owner {', '  export', '  const', '    entry = 1;', '}'].join(newline)

      const document = await workspace.openTextDocument({
        content,
        language: 'typescript'
      })

      const harness = createAnalysisHarness(document)
      const provider = new ZeroReferenceCodeActionProvider(harness.analyzer)
      const selection = new Range(3, 5, 3, 5)

      try {
        await harness.analyzer.analyze(document, harness.cancellation.token)

        const actions = provider.provideCodeActions(document, selection, context, harness.cancellation.token)
        const edit = actions[0]?.edit

        assert.equal(actions.length, 1)
        assert.ok(edit !== undefined)

        const insertion = edit.get(document.uri)[0]

        assert.equal(insertion?.newText, `  // zero-reference-ignore-next-line${newline}`)
        assert.ok(insertion.range.isEqual(new Range(1, 0, 1, 0)))
        assert.equal(harness.counts.documentSymbolCalls, 1)
        assert.equal(harness.counts.referenceNames.length, 2)
        assert.equal(await workspace.applyEdit(edit), true)
        assert.equal(document.getText(), ['namespace Owner {', '  // zero-reference-ignore-next-line', '  export', '  const', '    entry = 1;', '}'].join(newline))

        const suppressed = await harness.analyzer.analyze(document, harness.cancellation.token)

        assert.deepEqual(suppressed.map(finding => finding.name), ['Owner'])
        assert.equal(harness.counts.referenceNames.length, 3)

        const undo = new WorkspaceEdit()

        undo.delete(document.uri, new Range(1, 0, 2, 0))
        assert.equal(await workspace.applyEdit(undo), true)
        assert.equal(document.getText(), content)
        await harness.analyzer.analyze(document, harness.cancellation.token)
        assert.equal(provider.provideCodeActions(document, selection, context, harness.cancellation.token).length, 1)
        assert.equal(harness.counts.referenceNames.length, 5)
      } finally {
        harness.dispose()
      }
    })
  }

  for (const [opening, closing, language] of [
    ['const outer = (', ');', 'typescript'],
    ['consume(', ');', 'typescript'],
    ['const outer = [', '];', 'javascript'],
    ['const outer = typeof', ';', 'typescript'],
    ['const outer = void', ';', 'javascript'],
    ['const markup = <div>{', '}</div>;', 'typescriptreact'],
    ['const text = `${', '}`;', 'typescript']
  ]) {
    test(`does not offer an edit inside ${opening}`, async () => {
      assert.ok(opening !== undefined && closing !== undefined && language !== undefined)

      const content = [opening, '  /** Callback documentation. */', '  function entry() {}', closing].join('\n')

      const document = await workspace.openTextDocument({
        content,
        language
      })

      const harness = createAnalysisHarness(document)
      const provider = new ZeroReferenceCodeActionProvider(harness.analyzer)
      const selection = new Range(2, 12, 2, 12)

      try {
        const findings = await harness.analyzer.analyze(document, harness.cancellation.token)

        assert.ok(findings.some(finding => finding.name === 'entry'))
        assert.deepEqual(provider.provideCodeActions(document, selection, context, harness.cancellation.token), [])

        const calls = harness.counts.referenceNames.length
        const directive = new WorkspaceEdit()

        directive.insert(document.uri, new Position(2, 0), '  // zero-reference-ignore-next-line\n')
        assert.equal(await workspace.applyEdit(directive), true)

        const stillVisible = await harness.analyzer.analyze(document, harness.cancellation.token)
        const shiftedSelection = new Range(3, 12, 3, 12)

        assert.ok(stillVisible.some(finding => finding.name === 'entry'))
        assert.deepEqual(provider.provideCodeActions(document, shiftedSelection, context, harness.cancellation.token), [])
        assert.equal(harness.counts.documentSymbolCalls, 2)
        assert.equal(harness.counts.referenceNames.length, calls * 2)
      } finally {
        harness.dispose()
      }
    })
  }

  for (const newline of ['\n', '\r\n']) {
    test(`inserts an undoable suppression with original indentation and ${JSON.stringify(newline)}`, async () => {
      const content = ['class Owner {', '\tmember = 1;', '}'].join(newline)

      const document = await workspace.openTextDocument({
        content,
        language: 'typescript'
      })

      const harness = createAnalysisHarness(document)
      const provider = new ZeroReferenceCodeActionProvider(harness.analyzer)
      const selection = new Range(1, 2, 1, 2)

      try {
        assert.deepEqual(provider.provideCodeActions(document, selection, context, harness.cancellation.token), [])
        assert.equal(harness.counts.documentSymbolCalls, 0)
        assert.equal(harness.counts.referenceNames.length, 0)

        await harness.analyzer.analyze(document, harness.cancellation.token)

        const actions = provider.provideCodeActions(document, selection, context, harness.cancellation.token)

        assert.equal(actions.length, 1)

        const action = actions[0]

        assert.equal(action?.title, 'Zero Reference: Ignore this symbol')
        assert.equal(action.kind, CodeActionKind.QuickFix)
        assert.equal(action.isPreferred, undefined)
        assert.equal(action.command, undefined)
        assert.ok(action.edit !== undefined)

        const edits = action.edit.get(document.uri)

        assert.equal(edits.length, 1)
        assert.equal(edits[0]?.newText, `\t// zero-reference-ignore-next-line${newline}`)
        assert.ok(edits[0]?.range.isEqual(new Range(1, 0, 1, 0)))
        assert.equal(harness.counts.documentSymbolCalls, 1)
        assert.equal(harness.counts.referenceNames.length, 2)
        assert.equal(await workspace.applyEdit(action.edit), true)
        assert.equal(document.getText(), ['class Owner {', '\t// zero-reference-ignore-next-line', '\tmember = 1;', '}'].join(newline))
        assert.equal(document.isDirty, true)

        const findings = await harness.analyzer.analyze(document, harness.cancellation.token)

        assert.deepEqual(findings.map(finding => finding.name), ['Owner'])
        assert.deepEqual(provider.provideCodeActions(document, new Range(2, 2, 2, 2), context, harness.cancellation.token), [])

        const undo = new WorkspaceEdit()

        undo.delete(document.uri, new Range(1, 0, 2, 0))
        assert.equal(await workspace.applyEdit(undo), true)
        assert.equal(document.getText(), content)
        await harness.analyzer.analyze(document, harness.cancellation.token)
        assert.equal(provider.provideCodeActions(document, selection, context, harness.cancellation.token).length, 1)
      } finally {
        harness.dispose()
      }
    })
  }

  test('requires one current finding, an enabled display, a safe line, and Quick Fix context', async () => {
    const document = await workspace.openTextDocument({
      content: 'function first() {}\nfunction second() {}\nconst compactA = 1, compactB = 2;',
      language: 'typescript'
    })

    const harness = createAnalysisHarness(document)
    let enabled = true
    const provider = new ZeroReferenceCodeActionProvider(harness.analyzer, () => enabled)
    const selection = new Range(0, 10, 0, 10)

    try {
      await harness.analyzer.analyze(document, harness.cancellation.token)
      assert.equal(provider.provideCodeActions(document, selection, context, harness.cancellation.token).length, 1)
      assert.deepEqual(provider.provideCodeActions(document, new Range(0, 0, 0, 8), context, harness.cancellation.token), [])
      assert.deepEqual(provider.provideCodeActions(document, new Range(0, 0, 1, 20), context, harness.cancellation.token), [])
      assert.deepEqual(provider.provideCodeActions(document, new Range(2, 7, 2, 7), context, harness.cancellation.token), [])

      const refactorContext: CodeActionContext = {
        diagnostics: [],
        triggerKind: CodeActionTriggerKind.Invoke,
        only: CodeActionKind.Refactor
      }

      assert.deepEqual(provider.provideCodeActions(document, selection, refactorContext, harness.cancellation.token), [])
      enabled = false
      assert.deepEqual(provider.provideCodeActions(document, selection, context, harness.cancellation.token), [])
      enabled = true

      const cancelled = new CancellationTokenSource()

      cancelled.cancel()
      assert.deepEqual(provider.provideCodeActions(document, selection, context, cancelled.token), [])
      cancelled.dispose()
      assert.equal(harness.counts.documentSymbolCalls, 1)
      assert.equal(harness.counts.referenceNames.length, 4)

      harness.analyzer.invalidateConfiguration()
      assert.deepEqual(provider.provideCodeActions(document, selection, context, harness.cancellation.token), [])
      await harness.analyzer.analyze(document, harness.cancellation.token)
      harness.analyzer.invalidateGraph()
      assert.deepEqual(provider.provideCodeActions(document, selection, context, harness.cancellation.token), [])
      await harness.analyzer.analyze(document, harness.cancellation.token)

      const edit = new WorkspaceEdit()

      edit.insert(document.uri, new Position(0, 0), '\n')
      assert.equal(await workspace.applyEdit(edit), true)
      assert.deepEqual(provider.provideCodeActions(document, selection, context, harness.cancellation.token), [])
      await harness.analyzer.analyze(document, harness.cancellation.token)
      harness.analyzer.forgetDocument(document.uri)
      assert.deepEqual(provider.provideCodeActions(document, selection, context, harness.cancellation.token), [])
      await harness.analyzer.analyze(document, harness.cancellation.token)
      harness.analyzer.dispose()
      assert.deepEqual(provider.provideCodeActions(document, new Range(1, 10, 1, 10), context, harness.cancellation.token), [])
    } finally {
      harness.dispose()
    }
  })

  test('does not offer suppression for a used declaration', async () => {
    const document = await workspace.openTextDocument({
      content: 'function entry() {}\nentry();',
      language: 'typescript'
    })

    const harness = createAnalysisHarness(document, symbol => [
      new Location(document.uri, symbol.declarationRange),
      new Location(document.uri, new Range(1, 0, 1, 5))
    ])

    const provider = new ZeroReferenceCodeActionProvider(harness.analyzer)

    try {
      await harness.analyzer.analyze(document, harness.cancellation.token)
      assert.deepEqual(provider.provideCodeActions(document, new Range(0, 10, 0, 10), context, harness.cancellation.token), [])
      assert.deepEqual(harness.counts.referenceNames, ['entry'])
    } finally {
      harness.dispose()
    }
  })
})
