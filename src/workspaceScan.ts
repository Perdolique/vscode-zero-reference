import {
  CancellationTokenSource,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  extensions,
  languages,
  workspace
} from 'vscode'

import type { CancellationToken, DiagnosticCollection, Disposable, LogOutputChannel, Progress, Uri } from 'vscode'
import type { AnalysisInvalidation, ZeroReferenceAnalyzer, ZeroReferenceFinding } from './analysis.js'
import { isDocumentExcluded } from './config.js'
import { isSupportedLanguage } from './symbols.js'

const supportedFiles = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'
const staleMessage = 'Results from a previous scan; run Scan Workspace to update'

export interface WorkspaceScanResult {
  readonly status: 'complete' | 'incomplete' | 'cancelled' | 'failed' | 'noWorkspace';
  readonly checkedFiles: number;
  readonly skippedFiles: number;
  readonly incompleteFiles: number;
  readonly findings: number;
}

interface ScanCounts {
  checkedFiles: number;
  skippedFiles: number;
  incompleteFiles: number;
  findings: number;
}

export interface ScanProgress {
  readonly message?: string;
  readonly increment?: number;
}

interface FileFindings {
  readonly uri: Uri;
  readonly findings: readonly ZeroReferenceFinding[];
}

/** Owns manual scans and their persistent-in-window diagnostic snapshot, independently of editor display. */
export class ZeroReferenceWorkspaceScanner implements Disposable {
  private readonly invalidationSubscription: Disposable
  private snapshot = new Map<string, FileFindings>()
  private active: CancellationTokenSource | undefined
  private isDisposed = false

  constructor(
    private readonly analyzer: ZeroReferenceAnalyzer,
    private readonly output: Pick<LogOutputChannel, 'error' | 'info' | 'warn'>,
    private readonly diagnostics: DiagnosticCollection = languages.createDiagnosticCollection('Zero Reference'),
    private readonly findFiles: (token: CancellationToken) => Thenable<readonly Uri[]> = findWorkspaceFiles
  ) {
    this.invalidationSubscription = analyzer.onDidInvalidate(event => {
      this.invalidate(event)
    })
  }

  async scan(progress: Progress<ScanProgress>, token: CancellationToken): Promise<WorkspaceScanResult> {
    this.cancelActive()

    const cancellation = new CancellationTokenSource()
    const cancellationSubscription = token.onCancellationRequested(() => cancellation.cancel())

    const counts: ScanCounts = {
      checkedFiles: 0,
      skippedFiles: 0,
      incompleteFiles: 0,
      findings: 0
    }

    this.active = cancellation

    if (token.isCancellationRequested) {
      cancellation.cancel()
    }

    let status: WorkspaceScanResult['status']

    try {
      status = await this.run(cancellation, progress, counts)
    } catch (error: unknown) {
      if (this.isCurrent(cancellation)) {
        this.output.error('Workspace scan failed during file discovery.', error)
        status = 'failed'
      } else {
        status = 'cancelled'
      }
    } finally {
      if (this.active === cancellation) {
        this.active = undefined
      }

      cancellationSubscription.dispose()
      cancellation.dispose()
    }

    const result: WorkspaceScanResult = {
      status,
      checkedFiles: counts.checkedFiles,
      skippedFiles: counts.skippedFiles,
      incompleteFiles: counts.incompleteFiles,
      findings: counts.findings
    }

    const summary = `Workspace scan ${status}: ${counts.checkedFiles} checked, ${counts.skippedFiles} skipped, ${counts.incompleteFiles} incomplete files; ${counts.findings} findings.`

    this.output.info(summary)

    return result
  }

  clear(): void {
    this.cancelActive()
    this.snapshot.clear()
    this.diagnostics.clear()
  }

  dispose(): void {
    if (this.isDisposed) {
      return
    }

    this.isDisposed = true
    this.clear()
    this.invalidationSubscription.dispose()
    this.diagnostics.dispose()
  }

  private async run(
    cancellation: CancellationTokenSource,
    progress: Progress<ScanProgress>,
    counts: ScanCounts
  ): Promise<WorkspaceScanResult['status']> {
    if (!this.isCurrent(cancellation)) {
      return 'cancelled'
    }

    if (workspace.workspaceFolders === undefined || workspace.workspaceFolders.length === 0) {
      return 'noWorkspace'
    }

    progress.report({ message: 'Preparing TypeScript and JavaScript analysis…' })

    const languageExtension = extensions.getExtension('vscode.typescript-language-features')

    await languageExtension?.activate()

    if (!this.isCurrent(cancellation)) {
      return 'cancelled'
    }

    progress.report({ message: 'Finding TypeScript and JavaScript files…' })

    const discovered = await this.findFiles(cancellation.token)
    const uniqueFiles = new Map<string, Uri>()

    for (const uri of discovered) {
      uniqueFiles.set(uri.toString(), uri)
    }

    const files = [...uniqueFiles.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    const findings = new Map<string, FileFindings>()

    for (const [index, [key, uri]] of files.entries()) {
      if (!this.isCurrent(cancellation)) {
        return 'cancelled'
      }

      const relativePath = workspace.asRelativePath(uri, true)
      const message = `${index + 1}/${files.length}: ${relativePath}`

      progress.report({ message })

      if (isDependencyOrOutsideWorkspace(uri)) {
        counts.skippedFiles += 1
      } else {
        try {
          const document = await workspace.openTextDocument(uri)

          if (!this.isCurrent(cancellation)) {
            return 'cancelled'
          }

          const reportWarning = this.output.warn.bind(this.output)
          const excluded = isDocumentExcluded(document, reportWarning)

          if (!isSupportedLanguage(document.languageId) || excluded) {
            counts.skippedFiles += 1
          } else {
            const result = await this.analyzer.analyzeDetailed(document, cancellation.token)

            if (!this.isCurrent(cancellation)) {
              return 'cancelled'
            }

            if (result.status === 'complete') {
              counts.checkedFiles += 1
            } else {
              counts.incompleteFiles += 1

              const warning = `Could not fully analyze ${uri.toString()}; some declarations could not be confirmed.`

              this.output.warn(warning)
            }

            if (result.findings.length > 0) {
              findings.set(key, {
                uri,
                findings: result.findings
              })

              counts.findings += result.findings.length
            }
          }
        } catch (error: unknown) {
          if (!this.isCurrent(cancellation)) {
            return 'cancelled'
          }

          counts.incompleteFiles += 1

          const message = `Could not analyze ${uri.toString()}.`

          this.output.error(message, error)
        }
      }

      const increment = 100 / files.length

      progress.report({ increment })
    }

    if (!this.isCurrent(cancellation)) {
      return 'cancelled'
    }

    this.publish(findings, false)

    return counts.incompleteFiles > 0 ? 'incomplete' : 'complete'
  }

  private invalidate(event: AnalysisInvalidation): void {
    if (event.reason === 'configuration') {
      this.clear()

      return
    }

    this.cancelActive()

    const remaining = new Map<string, FileFindings>()

    for (const [key, file] of this.snapshot) {
      const affected = event.resources.some(resource => containsResource(resource, file.uri))

      if (!affected) {
        remaining.set(key, file)
      }
    }

    this.publish(remaining, true)
  }

  private publish(snapshot: Map<string, FileFindings>, stale: boolean): void {
    const entries: [Uri, Diagnostic[] | undefined][] = []

    for (const [key, file] of this.snapshot) {
      if (!snapshot.has(key)) {
        entries.push([file.uri, undefined])
      }
    }

    for (const file of snapshot.values()) {
      const diagnostics = file.findings.map(finding => {
        const currentMessage = `"${finding.name}" has zero workspace references. External and dynamic consumers may not be visible.`

        const message = stale
          ? `"${finding.name}": ${staleMessage}`
          : currentMessage

        const diagnostic = new Diagnostic(finding.declarationRange, message, DiagnosticSeverity.Information)

        diagnostic.source = 'Zero Reference'
        diagnostic.code = 'zero-reference'
        diagnostic.tags = stale ? [] : [DiagnosticTag.Unnecessary]

        return diagnostic
      })

      entries.push([file.uri, diagnostics])
    }

    this.snapshot = snapshot
    this.diagnostics.set(entries)
  }

  private cancelActive(): void {
    this.active?.cancel()
    this.active = undefined
  }

  private isCurrent(cancellation: CancellationTokenSource): boolean {
    return !this.isDisposed && this.active === cancellation && !cancellation.token.isCancellationRequested
  }
}

/** Uses native file exclusions, without importing search exclusions or ignore files. */
function findWorkspaceFiles(token: CancellationToken): Thenable<readonly Uri[]> {
  return workspace.findFiles(supportedFiles, undefined, undefined, token)
}

function isDependencyOrOutsideWorkspace(uri: Uri): boolean {
  const folder = workspace.getWorkspaceFolder(uri)

  if (folder === undefined) {
    return true
  }

  const relativePath = uri.path.slice(folder.uri.path.length)
  const segments = relativePath.split('/')

  return segments.includes('node_modules') || segments.includes('.git')
}

function containsResource(parent: Uri, child: Uri): boolean {
  const prefix = parent.path.endsWith('/') ? parent.path : `${parent.path}/`

  return parent.scheme === child.scheme
    && parent.authority === child.authority
    && (parent.path === child.path || child.path.startsWith(prefix))
}
