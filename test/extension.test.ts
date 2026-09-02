import { strict as assert } from 'node:assert'
import { commands, ConfigurationTarget, extensions, Range, Uri, WorkspaceEdit, workspace } from 'vscode'
import type { CodeAction, CodeLens } from 'vscode'
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

  test('registers the Quick Fix and refreshes actual CodeLens after applying and removing suppression', async () => {
    const folder = workspace.workspaceFolders?.[0]

    assert.ok(folder !== undefined)

    const uri = Uri.joinPath(folder.uri, 'action.ts')
    const document = await workspace.openTextDocument(uri)
    const original = document.getText()
    const nameRange = new Range(0, 16, 0, 21)
    const configuration = workspace.getConfiguration('zeroReference')
    const previousExclusions = configuration.inspect('exclude')?.workspaceValue

    try {
      const lenses = await commands.executeCommand<CodeLens[]>('vscode.executeCodeLensProvider', uri)

      assert.ok(lenses?.some(lens => lens.command?.title === '"entry" has zero references'))

      const actions = await commands.executeCommand<CodeAction[]>('vscode.executeCodeActionProvider', uri, nameRange)
      const ignore = actions?.find(action => action.title === 'Zero Reference: Ignore this symbol')

      assert.ok(ignore?.edit !== undefined)
      assert.equal(await workspace.applyEdit(ignore.edit), true)

      const suppressedLenses = await commands.executeCommand<CodeLens[]>('vscode.executeCodeLensProvider', uri)

      assert.equal(suppressedLenses?.some(lens => lens.command?.title === '"entry" has zero references'), false)

      const restore = new WorkspaceEdit()

      restore.replace(uri, new Range(0, 0, document.lineCount, 0), original)
      assert.equal(await workspace.applyEdit(restore), true)

      const restoredLenses = await commands.executeCommand<CodeLens[]>('vscode.executeCodeLensProvider', uri)

      assert.ok(restoredLenses?.some(lens => lens.command?.title === '"entry" has zero references'))
      await configuration.update('exclude', ['action.ts'], ConfigurationTarget.Workspace)

      const excludedActions = await commands.executeCommand<CodeAction[]>('vscode.executeCodeActionProvider', uri, nameRange)

      assert.equal(excludedActions?.some(action => action.title === 'Zero Reference: Ignore this symbol'), false)
    } finally {
      await configuration.update('exclude', previousExclusions, ConfigurationTarget.Workspace)

      const restore = new WorkspaceEdit()

      restore.replace(uri, new Range(0, 0, document.lineCount, 0), original)
      await workspace.applyEdit(restore)
    }
  })
})
