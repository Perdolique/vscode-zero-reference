import { Disposable, FileType, workspace } from 'vscode'
import type { Uri } from 'vscode'
import type { ZeroReferenceAnalyzer } from './analysis.js'
import { registerAnalysisConfigurationListener } from './config.js'
import { isSupportedFile, isSupportedLanguage } from './symbols.js'

/** Connects workspace and configuration changes to shared analysis state. */
export function registerAnalysisLifecycle(
  analyzer: ZeroReferenceAnalyzer
): Disposable {
  const fileWatcher = workspace.createFileSystemWatcher('**')

  const subscriptions = [
    registerAnalysisConfigurationListener(() => analyzer.invalidateConfiguration()),
    workspace.onDidChangeWorkspaceFolders(() => analyzer.invalidateConfiguration()),
    workspace.onDidChangeTextDocument(event => {
      const hasContentChanges = event.contentChanges.length > 0
      const hasSupportedLanguage = isSupportedLanguage(event.document.languageId)

      if (hasContentChanges && hasSupportedLanguage) {
        analyzer.invalidateGraph([event.document.uri])
      }
    }),
    workspace.onDidCloseTextDocument(document => {
      analyzer.forgetDocument(document.uri)
    }),
    fileWatcher,
    fileWatcher.onDidCreate(uri => {
      void invalidateCreatedResource(uri, analyzer)
    }),
    fileWatcher.onDidChange(uri => {
      if (isSupportedFile(uri)) {
        analyzer.invalidateGraph([uri])
      }
    }),
    fileWatcher.onDidDelete(uri => {
      analyzer.invalidateGraph([uri])
    })
  ]

  const lifecycle = Disposable.from(...subscriptions)

  return lifecycle
}

async function invalidateCreatedResource(
  uri: Uri,
  analyzer: ZeroReferenceAnalyzer
): Promise<void> {
  if (isSupportedFile(uri)) {
    analyzer.invalidateGraph([uri])

    return
  }

  try {
    const resourceStat = await workspace.fs.stat(uri)
    const isDirectory = (resourceStat.type & FileType.Directory) !== 0

    if (isDirectory) {
      analyzer.invalidateGraph([uri])
    }
  } catch {
    // The resource can disappear again before the asynchronous stat completes.
  }
}
