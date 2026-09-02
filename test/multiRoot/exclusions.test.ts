import { strict as assert } from 'node:assert'
import { ConfigurationTarget, Uri, workspace } from 'vscode'
import { registerAnalysisLifecycle } from '../../src/analysisLifecycle.js'
import { ZeroReferenceCodeLensProvider } from '../../src/codeLensProvider.js'
import { createAnalysisHarness } from '../analysisHarness.js'

suite('multi-root exclusions', () => {
  test('applies standard user, workspace, and folder precedence to identical relative paths', async () => {
    const folders = workspace.workspaceFolders

    assert.equal(folders?.length, 2)

    const first = folders?.[0]
    const second = folders?.[1]

    assert.ok(first !== undefined && second !== undefined)

    const firstDocument = await workspace.openTextDocument(Uri.joinPath(first.uri, 'same.ts'))
    const secondDocument = await workspace.openTextDocument(Uri.joinPath(second.uri, 'same.ts'))
    const firstHarness = createAnalysisHarness(firstDocument)
    const secondHarness = createAnalysisHarness(secondDocument)
    const lifecycle = registerAnalysisLifecycle(firstHarness.analyzer)
    const secondLifecycle = registerAnalysisLifecycle(secondHarness.analyzer)
    const firstConfiguration = workspace.getConfiguration('zeroReference', firstDocument.uri)
    const secondConfiguration = workspace.getConfiguration('zeroReference', secondDocument.uri)
    const globalValue = firstConfiguration.inspect('exclude')?.globalValue

    try {
      await firstConfiguration.update('exclude', ['**/*.ts'], ConfigurationTarget.Global)
      assert.deepEqual(await firstHarness.analyzer.analyze(firstDocument, firstHarness.cancellation.token), [])
      assert.deepEqual(await secondHarness.analyzer.analyze(secondDocument, secondHarness.cancellation.token), [])
      assert.equal(firstHarness.counts.documentSymbolCalls, 0)
      assert.equal(secondHarness.counts.documentSymbolCalls, 0)

      await firstConfiguration.update('exclude', [], ConfigurationTarget.Workspace)
      assert.equal((await firstHarness.analyzer.analyze(firstDocument, firstHarness.cancellation.token)).length, 1)
      assert.equal((await secondHarness.analyzer.analyze(secondDocument, secondHarness.cancellation.token)).length, 1)
      await firstConfiguration.update('exclude', ['same.ts'], ConfigurationTarget.WorkspaceFolder)
      await secondConfiguration.update('exclude', ['*.js'], ConfigurationTarget.WorkspaceFolder)

      assert.deepEqual(await firstHarness.analyzer.analyze(firstDocument, firstHarness.cancellation.token), [])
      assert.equal((await secondHarness.analyzer.analyze(secondDocument, secondHarness.cancellation.token)).length, 1)
      assert.equal(firstHarness.counts.documentSymbolCalls, 1)
      assert.equal(secondHarness.counts.documentSymbolCalls, 2)
      await firstConfiguration.update('exclude', [], ConfigurationTarget.WorkspaceFolder)
      assert.equal((await firstHarness.analyzer.analyze(firstDocument, firstHarness.cancellation.token)).length, 1)
      assert.equal(firstHarness.counts.documentSymbolCalls, 2)
    } finally {
      await firstConfiguration.update('exclude', undefined, ConfigurationTarget.WorkspaceFolder)
      await secondConfiguration.update('exclude', undefined, ConfigurationTarget.WorkspaceFolder)
      await firstConfiguration.update('exclude', undefined, ConfigurationTarget.Workspace)
      await firstConfiguration.update('exclude', globalValue, ConfigurationTarget.Global)
      lifecycle.dispose()
      secondLifecycle.dispose()
      firstHarness.dispose()
      secondHarness.dispose()
    }
  })

  test('invalidates cached results and refreshes CodeLens when workspace folders change', async () => {
    const first = workspace.workspaceFolders?.[0]

    assert.ok(first !== undefined)

    const thirdUri = Uri.joinPath(first.uri, '..', 'third')
    const document = await workspace.openTextDocument(Uri.joinPath(first.uri, 'same.ts'))
    const harness = createAnalysisHarness(document)
    const lifecycle = registerAnalysisLifecycle(harness.analyzer)
    const provider = new ZeroReferenceCodeLensProvider(harness.analyzer)
    let refreshCount = 0
    const subscription = provider.onDidChangeCodeLenses(() => { refreshCount += 1 })

    try {
      const original = await harness.analyzer.analyze(document, harness.cancellation.token)

      assert.equal(original.length, 1)

      const changed = new Promise<void>(resolve => {
        const listener = workspace.onDidChangeWorkspaceFolders(() => {
          listener.dispose()
          resolve()
        })
      })

      assert.equal(workspace.updateWorkspaceFolders(2, 0, { uri: thirdUri }), true)
      await changed
      assert.ok(refreshCount > 0)
      assert.deepEqual(harness.analyzer.getCachedFindings(document, harness.cancellation.token), [])
      assert.equal((await harness.analyzer.analyze(document, harness.cancellation.token)).length, 1)
      assert.equal(harness.counts.documentSymbolCalls, 2)
    } finally {
      subscription.dispose()
      provider.dispose()
      lifecycle.dispose()
      harness.dispose()
      workspace.updateWorkspaceFolders(2, 1)
    }
  })
})
