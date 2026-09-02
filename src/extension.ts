import { commands, languages } from 'vscode'
import type { ExtensionContext } from 'vscode'
import { ZeroReferenceAnalyzer } from './analysis.js'
import { registerAnalysisLifecycle } from './analysisLifecycle.js'
import { ZeroReferenceCodeLensProvider } from './codeLensProvider.js'
import { getUseCodeLens, updateUseCodeLens } from './config.js'
import { getDocumentFilter } from './symbols.js'

export function activate(context: ExtensionContext): void {
  const analyzer = new ZeroReferenceAnalyzer()
  const codeLensProvider = new ZeroReferenceCodeLensProvider(analyzer)
  const documentFilter = getDocumentFilter()
  const refreshAnalysis = createRefreshHandler(analyzer)

  context.subscriptions.push(
    codeLensProvider,
    analyzer,
    commands.registerCommand('zeroReference.toggleCodeLens', async () => {
      const useCodeLens = getUseCodeLens()

      await updateUseCodeLens(!useCodeLens)
    }),
    commands.registerCommand('zeroReference.refresh', refreshAnalysis),
    registerAnalysisLifecycle(analyzer),
    languages.registerCodeLensProvider(documentFilter, codeLensProvider)
  )
}

/** Creates the public refresh command handler for shared analysis state. */
export function createRefreshHandler(
  analyzer: ZeroReferenceAnalyzer
): () => void {
  return () => analyzer.invalidateGraph()
}
