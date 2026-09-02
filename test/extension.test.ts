import { strict as assert } from 'node:assert'
import { commands, extensions, Uri, workspace } from 'vscode'
import type { CodeLens } from 'vscode'
import { ZeroReferenceAnalyzer } from '../src/analysis.js'
import type { CommandExecutor } from '../src/analysis.js'
import { createRefreshHandler } from '../src/extension.js'

suite('extension integration', () => {
  test('registers the manual refresh command', async () => {
    const extension = extensions.all.find(candidate =>
      candidate.packageJSON.name === 'zero-reference'
    )

    assert.ok(extension !== undefined)
    await extension.activate()
    await commands.executeCommand('zeroReference.refresh')
  })

  test('manual refresh handler invalidates analysis state', () => {
    const executeCommand: CommandExecutor = async <Result>() => [] as Result
    const analyzer = new ZeroReferenceAnalyzer(executeCommand)
    const refreshAnalysis = createRefreshHandler(analyzer)
    let invalidationCount = 0

    const subscription = analyzer.onDidInvalidate(() => {
      invalidationCount += 1
    })

    refreshAnalysis()

    assert.equal(invalidationCount, 1)
    subscription.dispose()
    analyzer.dispose()
  })

  test('classifies the TypeScript fixture conservatively', async () => {
    const extension = extensions.all.find(candidate =>
      candidate.packageJSON.name === 'zero-reference'
    )

    const workspaceFolder = workspace.workspaceFolders?.[0]

    assert.ok(extension !== undefined)
    assert.ok(workspaceFolder !== undefined)
    await extension.activate()

    const documentUri = Uri.joinPath(workspaceFolder.uri, 'fixture.ts')

    await workspace.openTextDocument(documentUri)

    const codeLenses = await commands.executeCommand<CodeLens[]>(
      'vscode.executeCodeLensProvider',
      documentUri
    )

    const titles = codeLenses?.flatMap(codeLens =>
      codeLens.command === undefined ? [] : [codeLens.command.title]
    ) ?? []

    assert.equal(titles.filter(title => title.includes('MergedModel')).length, 1)
    assert.equal(titles.filter(title => title.includes('overloaded')).length, 1)
    assert.equal(titles.some(title => title.includes('["literal"]')), false)
    assert.equal(titles.some(title => title.includes('shorthandValue')), false)

    const ignoredTitles = [
      '"Bindings" has zero references',
      '"environment" has zero references',
      '"runtime" has zero references',
      '"status" has zero references',
      '"error" has zero references',
      '"default" has zero references'
    ]

    for (const ignoredTitle of ignoredTitles) {
      assert.equal(titles.includes(ignoredTitle), false, ignoredTitle)
    }

    assert.equal(
      titles.includes('"preservedClassProperty" has zero references'),
      true
    )
  })
})
