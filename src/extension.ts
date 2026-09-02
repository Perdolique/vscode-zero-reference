import { CodeActionKind, commands, languages, window } from 'vscode'
import type { ExtensionContext } from 'vscode'
import { ZeroReferenceAnalyzer } from './analysis.js'
import { registerAnalysisLifecycle } from './analysisLifecycle.js'
import { ZeroReferenceCodeLensProvider } from './codeLensProvider.js'
import { ZeroReferenceCodeActionProvider } from './codeActionProvider.js'
import { getUseCodeLens, updateUseCodeLens } from './config.js'
import { getDocumentFilter } from './symbols.js'

export function activate(context: ExtensionContext): void {
  const outputChannel = window.createOutputChannel('Zero Reference', { log: true })
  const reportConfigurationWarning = outputChannel.warn.bind(outputChannel)
  const analyzer = new ZeroReferenceAnalyzer(undefined, reportConfigurationWarning)
  const codeLensProvider = new ZeroReferenceCodeLensProvider(analyzer)
  const codeActionProvider = new ZeroReferenceCodeActionProvider(analyzer)
  const documentFilter = getDocumentFilter()
  const refreshAnalysis = createRefreshHandler(analyzer)

  context.subscriptions.push(
    codeLensProvider,
    analyzer,
    outputChannel,
    commands.registerCommand('zeroReference.toggleCodeLens', async () => {
      const useCodeLens = getUseCodeLens()

      await updateUseCodeLens(!useCodeLens)
    }),
    commands.registerCommand('zeroReference.refresh', refreshAnalysis),
    registerAnalysisLifecycle(analyzer),
    languages.registerCodeLensProvider(documentFilter, codeLensProvider),
    languages.registerCodeActionsProvider(documentFilter, codeActionProvider, {
      providedCodeActionKinds: [CodeActionKind.QuickFix]
    })
  )
}

/** Creates the public refresh command handler for shared analysis state. */
export function createRefreshHandler(
  analyzer: ZeroReferenceAnalyzer
): () => void {
  return () => analyzer.invalidateGraph()
}
