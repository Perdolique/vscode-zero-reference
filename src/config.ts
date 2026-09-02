import { ConfigurationTarget, languages, RelativePattern, workspace } from 'vscode'
import type { Disposable, TextDocument } from 'vscode'

const useCodeLensKey = 'useCodeLens'
const useCodeLensConfigurationKey = `zeroReference.${useCodeLensKey}`
const excludeConfigurationKey = 'zeroReference.exclude'

export function isDocumentExcluded(
  document: TextDocument,
  reportWarning: (message: string) => void
): boolean {
  const folder = workspace.getWorkspaceFolder(document.uri)

  if (folder === undefined) {
    return false
  }

  const configuration = workspace.getConfiguration('zeroReference', document.uri)
  const value = configuration.get<unknown>('exclude', [])
  const patterns = parseExcludePatterns(value, reportWarning)

  return patterns.some(pattern => {
    const relativePattern = new RelativePattern(folder, pattern)
    const score = languages.match({ pattern: relativePattern }, document)

    return score > 0
  })
}

/** Validates user settings without discarding valid exclusions alongside invalid entries. */
export function parseExcludePatterns(
  value: unknown,
  reportWarning: (message: string) => void
): readonly string[] {
  if (!Array.isArray(value)) {
    reportWarning('zeroReference.exclude must be an array of glob patterns; using no exclusions.')

    return []
  }

  const patterns: string[] = []

  for (const [index, pattern] of value.entries()) {
    if (typeof pattern !== 'string' || pattern.trim().length === 0) {
      reportWarning(`zeroReference.exclude[${index}] must be a non-empty string; ignoring this entry.`)
      continue
    }

    patterns.push(pattern)
  }

  return patterns
}

export function getUseCodeLens(): boolean {
  return workspace
    .getConfiguration('zeroReference')
    .get<boolean>(useCodeLensKey, true)
}

export async function updateUseCodeLens(value: boolean): Promise<void> {
  const configuration = workspace.getConfiguration('zeroReference')
  const inspection = configuration.inspect<boolean>(useCodeLensKey)

  const target = inspection?.workspaceValue === undefined
    ? ConfigurationTarget.Global
    : ConfigurationTarget.Workspace

  await configuration.update(useCodeLensKey, value, target)
}

export function registerAnalysisConfigurationListener(onChange: () => void): Disposable {
  return workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(useCodeLensConfigurationKey)
      || event.affectsConfiguration(excludeConfigurationKey)) {
      onChange()
    }
  })
}
