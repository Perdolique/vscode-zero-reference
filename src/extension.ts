import { CodeActionKind, commands, languages, ProgressLocation, window } from 'vscode'
import type { ExtensionContext, LogOutputChannel, Uri } from 'vscode'
import { ZeroReferenceAnalyzer } from './analysis.js'
import { registerAnalysisLifecycle } from './analysisLifecycle.js'
import { ZeroReferenceCodeLensProvider } from './codeLensProvider.js'
import { ZeroReferenceCodeActionProvider } from './codeActionProvider.js'
import { getUseCodeLens, updateUseCodeLens } from './config.js'
import { getDocumentFilter } from './symbols.js'
import { ZeroReferenceWorkspaceScanner } from './workspaceScan.js'
import type { WorkspaceScanResult } from './workspaceScan.js'

export function activate(context: ExtensionContext): void {
  const outputChannel = window.createOutputChannel('Zero Reference', { log: true })
  const reportConfigurationWarning = outputChannel.warn.bind(outputChannel)

  const reportProviderError = (error: unknown, uri: Uri): void => {
    const message = `Language provider failed for ${uri.toString()}.`

    outputChannel.error(message, error)
  }

  const analyzer = new ZeroReferenceAnalyzer(undefined, reportConfigurationWarning, reportProviderError)
  const scanner = new ZeroReferenceWorkspaceScanner(analyzer, outputChannel)
  const codeLensProvider = new ZeroReferenceCodeLensProvider(analyzer)
  const codeActionProvider = new ZeroReferenceCodeActionProvider(analyzer)
  const documentFilter = getDocumentFilter()
  const refreshAnalysis = createRefreshHandler(analyzer)

  context.subscriptions.push(
    codeLensProvider,
    scanner,
    analyzer,
    outputChannel,
    commands.registerCommand('zeroReference.toggleCodeLens', async () => {
      const useCodeLens = getUseCodeLens()

      await updateUseCodeLens(!useCodeLens)
    }),
    commands.registerCommand('zeroReference.refresh', refreshAnalysis),
    commands.registerCommand('zeroReference.scanWorkspace', () => scanWorkspace(scanner, outputChannel)),
    commands.registerCommand('zeroReference.clearWorkspaceScanResults', () => scanner.clear()),
    registerAnalysisLifecycle(analyzer),
    languages.registerCodeLensProvider(documentFilter, codeLensProvider),
    languages.registerCodeActionsProvider(documentFilter, codeActionProvider, {
      providedCodeActionKinds: [CodeActionKind.QuickFix]
    })
  )
}

async function scanWorkspace(
  scanner: ZeroReferenceWorkspaceScanner,
  output: LogOutputChannel
): Promise<WorkspaceScanResult> {
  const result = await window.withProgress({
    location: ProgressLocation.Notification,
    title: 'Zero Reference: Scan Workspace',
    cancellable: true
  }, (progress, token) => scanner.scan(progress, token))

  if (result.status === 'cancelled') {
    return result
  }

  if (result.status === 'noWorkspace') {
    void window.showInformationMessage('Open a folder or workspace to scan for zero references.')

    return result
  }

  if (result.status !== 'failed' && result.findings > 0) {
    await commands.executeCommand('workbench.actions.view.problems')
  }

  const summary = result.status === 'failed'
    ? 'Zero Reference could not find workspace files. Previous scan results were kept.'
    : `Zero Reference: ${result.findings} findings; ${result.checkedFiles} checked, ${result.skippedFiles} skipped, ${result.incompleteFiles} incomplete files.`

  const message = result.status === 'complete'
    ? window.showInformationMessage(summary, 'Show Output')
    : window.showWarningMessage(summary, 'Show Output')

  void message.then(action => {
    if (action === 'Show Output') {
      output.show(true)
    }
  })

  return result
}

/** Creates the public refresh command handler for shared analysis state. */
export function createRefreshHandler(
  analyzer: ZeroReferenceAnalyzer
): () => void {
  return () => analyzer.invalidateGraph()
}
