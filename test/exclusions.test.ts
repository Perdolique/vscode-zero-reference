import { strict as assert } from 'node:assert'

import {
  CancellationTokenSource,
  commands,
  ConfigurationTarget,
  Location,
  Range,
  Uri,
  WorkspaceEdit,
  workspace
} from 'vscode'

import { ZeroReferenceAnalyzer } from '../src/analysis.js'
import { registerAnalysisLifecycle } from '../src/analysisLifecycle.js'
import { isDocumentExcluded, parseExcludePatterns } from '../src/config.js'
import { createAnalysisHarness } from './analysisHarness.js'

suite('file exclusions', () => {
  let originalExclusions: unknown
  let originalFilesExclude: unknown

  setup(() => {
    originalExclusions = workspace.getConfiguration('zeroReference').inspect('exclude')?.workspaceValue
    originalFilesExclude = workspace.getConfiguration('files').inspect('exclude')?.workspaceValue
  })

  teardown(async () => {
    await workspace.getConfiguration('zeroReference').update('exclude', originalExclusions, ConfigurationTarget.Workspace)
    await workspace.getConfiguration('files').update('exclude', originalFilesExclude, ConfigurationTarget.Workspace)
  })

  test('skips excluded files before both providers and restores analysis after settings change', async () => {
    const folder = workspace.workspaceFolders?.[0]

    assert.ok(folder !== undefined)

    const excluded = await workspace.openTextDocument(Uri.joinPath(folder.uri, 'generated', 'excluded.ts'))
    const included = await workspace.openTextDocument(Uri.joinPath(folder.uri, 'included.ts'))
    const excludedHarness = createAnalysisHarness(excluded)
    const includedHarness = createAnalysisHarness(included)
    const lifecycle = registerAnalysisLifecycle(excludedHarness.analyzer)
    const configuration = workspace.getConfiguration('zeroReference')

    try {
      const original = await excludedHarness.analyzer.analyze(excluded, excludedHarness.cancellation.token)

      assert.ok(original.some(finding => finding.name === 'ignored'))
      await configuration.update('exclude', ['generated/**'], ConfigurationTarget.Workspace)
      assert.deepEqual(excludedHarness.analyzer.getCachedFindings(excluded, excludedHarness.cancellation.token), [])
      excludedHarness.counts.documentSymbolCalls = 0
      excludedHarness.counts.referenceNames.length = 0

      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.deepEqual(await excludedHarness.analyzer.analyze(excluded, excludedHarness.cancellation.token), [])
      }

      assert.equal(excludedHarness.counts.documentSymbolCalls, 0)
      assert.deepEqual(excludedHarness.counts.referenceNames, [])

      const includedFindings = await includedHarness.analyzer.analyze(included, includedHarness.cancellation.token)

      assert.deepEqual(includedFindings.map(finding => finding.name), ['entry'])
      assert.equal(includedHarness.counts.documentSymbolCalls, 1)
      await configuration.update('exclude', [], ConfigurationTarget.Workspace)

      const restored = await excludedHarness.analyzer.analyze(excluded, excludedHarness.cancellation.token)

      assert.ok(restored.some(finding => finding.name === 'ignored'))
      assert.equal(excludedHarness.counts.documentSymbolCalls, 1)
      assert.deepEqual(excludedHarness.counts.referenceNames, ['ignored'])
    } finally {
      lifecycle.dispose()
      excludedHarness.dispose()
      includedHarness.dispose()
    }
  })

  test('uses workspace-relative VS Code globs and does not inherit files.exclude', async () => {
    const folder = workspace.workspaceFolders?.[0]

    assert.ok(folder !== undefined)

    const included = await workspace.openTextDocument(Uri.joinPath(folder.uri, 'included.ts'))
    const nested = await workspace.openTextDocument(Uri.joinPath(folder.uri, 'generated', 'excluded.ts'))

    const outside = await workspace.openTextDocument({
      content: 'const outside = 1;',
      language: 'typescript'
    })

    const configuration = workspace.getConfiguration('zeroReference')
    const warnings: string[] = []
    const reportWarning = (message: string): void => { warnings.push(message) }

    await workspace.getConfiguration('files').update('exclude', { '**/*.ts': true }, ConfigurationTarget.Workspace)
    await configuration.update('exclude', [], ConfigurationTarget.Workspace)
    assert.equal(isDocumentExcluded(included, reportWarning), false)
    await configuration.update('exclude', ['*.ts'], ConfigurationTarget.Workspace)
    assert.equal(isDocumentExcluded(included, reportWarning), true)
    assert.equal(isDocumentExcluded(nested, reportWarning), false)
    await configuration.update('exclude', ['**/*.{ts,js}'], ConfigurationTarget.Workspace)
    assert.equal(isDocumentExcluded(included, reportWarning), true)
    assert.equal(isDocumentExcluded(nested, reportWarning), true)
    assert.equal(isDocumentExcluded(outside, reportWarning), false)
    assert.deepEqual(warnings, [])
  })

  test('keeps references from excluded files and invalidates their unsaved edits', async () => {
    const folder = workspace.workspaceFolders?.[0]

    assert.ok(folder !== undefined)

    const declaration = await workspace.openTextDocument(Uri.joinPath(folder.uri, 'included.ts'))
    const consumer = await workspace.openTextDocument(Uri.joinPath(folder.uri, 'generated', 'excluded.ts'))
    const originalContent = consumer.getText()
    const analyzer = new ZeroReferenceAnalyzer()
    const cancellation = new CancellationTokenSource()
    const lifecycle = registerAnalysisLifecycle(analyzer)

    try {
      await workspace.getConfiguration('zeroReference').update('exclude', ['generated/**'], ConfigurationTarget.Workspace)

      const references = await commands.executeCommand<Location[]>('vscode.executeReferenceProvider', declaration.uri, new Range(0, 16, 0, 16).start)

      assert.ok(references?.some(reference => reference.uri.toString() === consumer.uri.toString()))

      const used = await analyzer.analyze(declaration, cancellation.token)

      assert.deepEqual(used, [])

      const edit = new WorkspaceEdit()

      edit.replace(consumer.uri, new Range(0, 0, consumer.lineCount, 0), 'export const ignored = 1;\n')
      assert.equal(await workspace.applyEdit(edit), true)

      const unused = await analyzer.analyze(declaration, cancellation.token)

      assert.deepEqual(unused.map(finding => finding.name), ['entry'])
    } finally {
      lifecycle.dispose()
      analyzer.dispose()
      cancellation.dispose()

      const restore = new WorkspaceEdit()

      restore.replace(consumer.uri, new Range(0, 0, consumer.lineCount, 0), originalContent)
      await workspace.applyEdit(restore)
    }
  })

  test('discards in-flight findings when a file becomes excluded', async () => {
    const folder = workspace.workspaceFolders?.[0]

    assert.ok(folder !== undefined)

    const document = await workspace.openTextDocument(Uri.joinPath(folder.uri, 'included.ts'))
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const lookupStarted = new Promise<void>(resolve => { started = resolve })

    const harness = createAnalysisHarness(document, async symbol => {
      started?.()
      await gate

      return [new Location(document.uri, symbol.declarationRange)]
    })

    const lifecycle = registerAnalysisLifecycle(harness.analyzer)

    try {
      const pending = harness.analyzer.analyze(document, harness.cancellation.token)

      await lookupStarted
      assert.deepEqual(harness.analyzer.getCachedFindings(document, harness.cancellation.token), [])
      await workspace.getConfiguration('zeroReference').update('exclude', ['included.ts'], ConfigurationTarget.Workspace)
      release?.()
      assert.deepEqual(await pending, [])
      assert.deepEqual(harness.analyzer.getCachedFindings(document, harness.cancellation.token), [])
      assert.deepEqual(await harness.analyzer.analyze(document, harness.cancellation.token), [])
      assert.equal(harness.counts.documentSymbolCalls, 1)
      assert.equal(harness.counts.referenceNames.length, 1)
    } finally {
      release?.()
      lifecycle.dispose()
      harness.dispose()
    }
  })

  test('reports invalid settings while retaining valid entries', () => {
    const warnings: string[] = []
    const reportWarning = (message: string): void => { warnings.push(message) }

    for (const invalid of [null, true, 12, '**/*.ts', {}]) {
      assert.deepEqual(parseExcludePatterns(invalid, reportWarning), [])
    }

    assert.equal(warnings.length, 5)
    assert.ok(warnings.every(message => message.includes('zeroReference.exclude')))
    warnings.length = 0
    assert.deepEqual(parseExcludePatterns(['generated/**', 1, '', ' ', '**/*.generated.ts'], reportWarning), ['generated/**', '**/*.generated.ts'])
    assert.equal(warnings.length, 3)
    assert.ok(warnings[0]?.includes('[1]'))
    assert.ok(warnings[1]?.includes('[2]'))
    assert.ok(warnings[2]?.includes('[3]'))
  })

  test('logs invalid runtime configuration and keeps analysis operational', async () => {
    const folder = workspace.workspaceFolders?.[0]

    assert.ok(folder !== undefined)

    const document = await workspace.openTextDocument(Uri.joinPath(folder.uri, 'included.ts'))
    const harness = createAnalysisHarness(document)
    const lifecycle = registerAnalysisLifecycle(harness.analyzer)
    const configuration = workspace.getConfiguration('zeroReference')

    try {
      await configuration.update('exclude', ['included.ts', 42], ConfigurationTarget.Workspace)
      assert.deepEqual(await harness.analyzer.analyze(document, harness.cancellation.token), [])
      assert.equal(harness.counts.documentSymbolCalls, 0)
      assert.equal(harness.warnings.length, 1)
      assert.ok(harness.warnings[0]?.includes('zeroReference.exclude[1]'))
      await configuration.update('exclude', 'invalid', ConfigurationTarget.Workspace)

      const findings = await harness.analyzer.analyze(document, harness.cancellation.token)

      assert.deepEqual(findings.map(finding => finding.name), ['entry'])
      assert.equal(harness.counts.documentSymbolCalls, 1)
      assert.equal(harness.warnings.length, 2)
      assert.ok(harness.warnings[1]?.includes('must be an array'))
    } finally {
      lifecycle.dispose()
      harness.dispose()
    }
  })
})
