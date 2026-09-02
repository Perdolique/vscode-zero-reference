import { strict as assert } from 'node:assert'
import { ConfigurationTarget, workspace } from 'vscode'
import { createAnalysisHarness } from '../analysisHarness.js'

suite('exclusions without a workspace', () => {
  test('ignores file globs but still supports declaration suppression', async () => {
    assert.equal(workspace.workspaceFolders, undefined)

    const configuration = workspace.getConfiguration('zeroReference')
    const previousValue = configuration.inspect('exclude')?.globalValue

    const document = await workspace.openTextDocument({
      content: '// zero-reference-ignore-next-line\nfunction ignored() {}\nfunction entry() {}',
      language: 'typescript'
    })

    const harness = createAnalysisHarness(document)

    try {
      await configuration.update('exclude', ['**'], ConfigurationTarget.Global)

      const findings = await harness.analyzer.analyze(document, harness.cancellation.token)

      assert.deepEqual(findings.map(finding => finding.name), ['entry'])
      assert.equal(harness.counts.documentSymbolCalls, 1)
      assert.deepEqual(harness.counts.referenceNames, ['entry'])
    } finally {
      await configuration.update('exclude', previousValue, ConfigurationTarget.Global)
      harness.dispose()
    }
  })
})
