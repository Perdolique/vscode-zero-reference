import { CodeLens, EventEmitter } from 'vscode'
import type { CancellationToken, CodeLensProvider, Disposable, TextDocument } from 'vscode'
import type { ZeroReferenceAnalyzer } from './analysis.js'
import { getUseCodeLens } from './config.js'

export class ZeroReferenceCodeLensProvider implements CodeLensProvider, Disposable {
  private readonly analysisInvalidationSubscription: Disposable
  private readonly updateEventEmitter = new EventEmitter<void>()
  private isDisposed = false

  readonly onDidChangeCodeLenses = this.updateEventEmitter.event

  constructor(
    private readonly analyzer: ZeroReferenceAnalyzer,
    private readonly isEnabled: () => boolean = getUseCodeLens
  ) {
    this.analysisInvalidationSubscription = this.analyzer.onDidInvalidate(() => {
      this.updateEventEmitter.fire()
    })
  }

  async provideCodeLenses(
    document: TextDocument,
    token: CancellationToken
  ): Promise<CodeLens[]> {
    if (!this.isCurrent(token)) {
      return []
    }

    const findings = await this.analyzer.analyze(document, token)

    if (!this.isCurrent(token)) {
      return []
    }

    const codeLenses = findings.map(finding => {
      const command = {
        title: `"${finding.name}" has zero references`,
        command: ''
      }

      const codeLens = new CodeLens(finding.range, command)

      return codeLens
    })

    return codeLenses
  }

  dispose(): void {
    this.isDisposed = true
    this.analysisInvalidationSubscription.dispose()
    this.updateEventEmitter.dispose()
  }

  private isCurrent(token: CancellationToken): boolean {
    const isCurrent = !this.isDisposed
      && this.isEnabled()
      && !token.isCancellationRequested

    return isCurrent
  }
}
