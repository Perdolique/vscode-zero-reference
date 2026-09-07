import { CancellationTokenSource, commands, EventEmitter } from 'vscode'

import type {
  CancellationToken,
  Disposable,
  DocumentSymbol,
  Location,
  Range,
  SymbolInformation,
  TextDocument,
  Uri
} from 'vscode'

import { getSymbolData } from './symbols.js'
import type { SymbolData } from './symbols.js'
import { isDocumentExcluded } from './config.js'
import { getSuppressionLines, hasSuppressionComment } from './suppression.js'

const referenceConcurrency = 4

export type CommandExecutor = <Result>(
  command: string,
  ...args: readonly unknown[]
) => Thenable<Result | undefined>

const defaultCommandExecutor: CommandExecutor = commands.executeCommand

export interface ZeroReferenceFinding {
  readonly declarationRange: Range;
  readonly name: string;
  readonly range: Range;
  readonly suppressionLine?: number | undefined;
}

interface AnalysisIdentity {
  readonly configurationEpoch: number;
  readonly documentVersion: number;
  readonly graphEpoch: number;
}

export interface AnalysisResult {
  readonly findings: readonly ZeroReferenceFinding[];
  readonly status: 'complete' | 'incomplete' | 'cancelled';
}

export interface AnalysisInvalidation {
  readonly reason: 'graph' | 'configuration';
  readonly resources: readonly Uri[];
}

interface AnalysisCacheEntry extends AnalysisIdentity {
  readonly result: AnalysisResult;
}

interface PendingAnalysis extends AnalysisIdentity {
  readonly cancellation: CancellationTokenSource;
  consumers: number;
  readonly result: Promise<AnalysisResult>;
  settled: boolean;
}

interface FindingCandidate {
  readonly declarationGroupKey: string;
  readonly finding: ZeroReferenceFinding;
}

interface PendingAcquisition {
  cancellationSubscription: Disposable | undefined;
  readonly isCurrent: () => boolean;
  readonly resolve: (release: (() => void) | undefined) => void;
}

/** Owns shared zero-reference analysis, caching, and invalidation state. */
export class ZeroReferenceAnalyzer implements Disposable {
  private readonly cache = new Map<string, AnalysisCacheEntry>()
  private readonly pending = new Map<string, PendingAnalysis>()
  private readonly invalidationEventEmitter = new EventEmitter<AnalysisInvalidation>()
  private readonly referenceLookupLimiter = new ConcurrencyLimiter(referenceConcurrency)
  private configurationEpoch = 0
  private graphEpoch = 0
  private isDisposed = false

  readonly onDidInvalidate = this.invalidationEventEmitter.event

  constructor(
    private readonly executeCommand: CommandExecutor = defaultCommandExecutor,
    private readonly reportConfigurationWarning: (message: string) => void = console.warn,
    private readonly reportProviderError: (error: unknown, uri: Uri) => void = error => { console.error(error) }
  ) {}

  /** Reads only current completed analysis; editor actions must not trigger reference lookups. */
  getCachedFindings(
    document: TextDocument,
    token: CancellationToken
  ): readonly ZeroReferenceFinding[] {
    const identity = this.createIdentity(document)
    const documentKey = document.uri.toString()
    const cachedAnalysis = this.cache.get(documentKey)

    if (cachedAnalysis === undefined
      || !hasSameIdentity(cachedAnalysis, identity)
      || !this.isAnalysisCurrent(document, identity, token)) {
      return []
    }

    return cachedAnalysis.result.findings
  }

  async analyze(
    document: TextDocument,
    token: CancellationToken
  ): Promise<readonly ZeroReferenceFinding[]> {
    const result = await this.analyzeDetailed(document, token)

    return result.findings
  }

  /** Shares work between consumers while retaining scan completeness and independent cancellation. */
  analyzeDetailed(
    document: TextDocument,
    token: CancellationToken
  ): Promise<AnalysisResult> {
    const identity = this.createIdentity(document)

    if (!this.isAnalysisCurrent(document, identity, token)) {
      return Promise.resolve(cancelledResult())
    }

    const documentKey = document.uri.toString()
    const cachedAnalysis = this.cache.get(documentKey)

    if (cachedAnalysis !== undefined
      && hasSameIdentity(cachedAnalysis, identity)) {
      return Promise.resolve(cachedAnalysis.result)
    }

    if (isDocumentExcluded(document, this.reportConfigurationWarning)) {
      return Promise.resolve({
        findings: [],
        status: 'complete'
      })
    }

    let pending = this.pending.get(documentKey)

    if (pending !== undefined && (!hasSameIdentity(pending, identity)
      || pending.cancellation.token.isCancellationRequested)) {
      pending.cancellation.cancel()
      pending = undefined
    }

    if (pending === undefined) {
      const cancellation = new CancellationTokenSource()

      const result = Promise.resolve().then(async () => {
        try {
          return await this.runAnalysis(document, identity, cancellation.token)
        } catch (error: unknown) {
          this.reportProviderError(error, document.uri)

          return {
            findings: [],
            status: 'incomplete'
          } as const
        }
      }).finally(() => {
        entry.settled = true

        if (this.pending.get(documentKey) === entry) {
          this.pending.delete(documentKey)
        }

        cancellation.dispose()
      })

      const entry: PendingAnalysis = {
        cancellation,
        configurationEpoch: identity.configurationEpoch,
        consumers: 0,
        documentVersion: identity.documentVersion,
        graphEpoch: identity.graphEpoch,
        result,
        settled: false
      }

      pending = entry
      this.pending.set(documentKey, entry)
    }

    return this.joinAnalysis(pending, document, token)
  }

  private joinAnalysis(
    pending: PendingAnalysis,
    document: TextDocument,
    token: CancellationToken
  ): Promise<AnalysisResult> {
    pending.consumers += 1

    return new Promise(resolve => {
      let settled = false
      let consumerCancellation: Disposable | undefined
      let sharedCancellation: Disposable | undefined

      const finish = (result: AnalysisResult): void => {
        if (settled) {
          return
        }

        settled = true
        consumerCancellation?.dispose()
        sharedCancellation?.dispose()
        pending.consumers -= 1

        if (pending.consumers === 0 && !pending.settled) {
          pending.cancellation.cancel()
        }

        resolve(result)
      }

      const cancel = (): void => {
        const result = cancelledResult()

        finish(result)
      }

      consumerCancellation = token.onCancellationRequested(cancel)
      sharedCancellation = pending.cancellation.token.onCancellationRequested(cancel)

      void pending.result.then(result => {
        if (!this.isAnalysisCurrent(document, pending, token)) {
          cancel()

          return
        }

        finish(result)
      })

      if (token.isCancellationRequested || pending.cancellation.token.isCancellationRequested) {
        cancel()
      }
    })
  }

  private async runAnalysis(
    document: TextDocument,
    identity: AnalysisIdentity,
    token: CancellationToken
  ): Promise<AnalysisResult> {
    if (!this.isAnalysisCurrent(document, identity, token)) {
      return cancelledResult()
    }

    let hasLoggedError = false
    let hasProviderError = false
    let isIncomplete = false

    const logErrorOnce = (error: unknown): void => {
      hasProviderError = true
      isIncomplete = true

      if (hasLoggedError) {
        return
      }

      hasLoggedError = true
      this.reportProviderError(error, document.uri)
    }

    let symbols: DocumentSymbol[] | SymbolInformation[] | undefined

    try {
      symbols = await this.executeCommand<DocumentSymbol[] | SymbolInformation[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      )
    } catch (error: unknown) {
      logErrorOnce(error)

      return {
        findings: [],
        status: 'incomplete'
      }
    }

    if (!this.isAnalysisCurrent(document, identity, token)) {
      return cancelledResult()
    }

    if (symbols === undefined) {
      return {
        findings: [],
        status: 'incomplete'
      }
    }

    const symbolData = getSymbolData(symbols, document)
    const declarationIdentitiesByRange = getDeclarationIdentitiesByRange(symbolData)
    const suppressionLines = getSuppressionLines(symbols, document)
    const suppressedRanges = new Set<string>()

    for (const symbol of symbolData) {
      const line = suppressionLines.get(symbol.range.start.line)

      if (line !== undefined && hasSuppressionComment(document, line)) {
        const rangeKey = getRangeKey(symbol.declarationRange)

        suppressedRanges.add(rangeKey)
      }
    }

    const candidates = await this.findCandidates(
      document,
      identity,
      symbolData,
      declarationIdentitiesByRange,
      suppressionLines,
      suppressedRanges,
      token,
      logErrorOnce,
      () => { isIncomplete = true }
    )

    if (!this.isAnalysisCurrent(document, identity, token)) {
      return cancelledResult()
    }

    const findings = getUniqueFindings(candidates)

    const result: AnalysisResult = {
      findings,
      status: isIncomplete ? 'incomplete' : 'complete'
    }

    if (!hasProviderError) {
      const documentKey = document.uri.toString()

      this.cache.set(documentKey, {
        configurationEpoch: identity.configurationEpoch,
        documentVersion: identity.documentVersion,
        graphEpoch: identity.graphEpoch,
        result
      })
    }

    return result
  }

  invalidateGraph(resources: readonly Uri[] = []): void {
    if (this.isDisposed) {
      return
    }

    this.graphEpoch += 1

    this.invalidateAll({
      reason: 'graph',
      resources
    })
  }

  invalidateConfiguration(): void {
    if (this.isDisposed) {
      return
    }

    this.configurationEpoch += 1

    this.invalidateAll({
      reason: 'configuration',
      resources: []
    })
  }

  forgetDocument(uri: Uri): void {
    const documentKey = uri.toString()

    this.cache.delete(documentKey)
    this.pending.get(documentKey)?.cancellation.cancel()
    this.pending.delete(documentKey)
  }

  dispose(): void {
    this.isDisposed = true
    this.cache.clear()
    this.cancelPending()
    this.invalidationEventEmitter.dispose()
  }

  private createIdentity(document: TextDocument): AnalysisIdentity {
    return {
      configurationEpoch: this.configurationEpoch,
      documentVersion: document.version,
      graphEpoch: this.graphEpoch
    }
  }

  private invalidateAll(event: AnalysisInvalidation): void {
    this.cache.clear()
    this.cancelPending()
    this.invalidationEventEmitter.fire(event)
  }

  private cancelPending(): void {
    for (const entry of this.pending.values()) {
      entry.cancellation.cancel()
    }

    this.pending.clear()
  }

  private async findCandidates(
    document: TextDocument,
    identity: AnalysisIdentity,
    symbols: readonly SymbolData[],
    declarationIdentitiesByRange: ReadonlyMap<string, ReadonlySet<string>>,
    suppressionLines: ReadonlyMap<number, number>,
    suppressedRanges: ReadonlySet<string>,
    token: CancellationToken,
    logErrorOnce: (error: unknown) => void,
    reportIncomplete: () => void
  ): Promise<readonly (FindingCandidate | null)[]> {
    const candidates: (FindingCandidate | null)[] = Array.from(
      { length: symbols.length },
      () => null
    )

    let nextSymbolIndex = 0

    const isCurrent = (): boolean => this.isAnalysisCurrent(
      document,
      identity,
      token
    )

    const runWorker = async (): Promise<void> => {
      while (isCurrent()) {
        const symbolIndex = nextSymbolIndex

        if (symbolIndex >= symbols.length) {
          return
        }

        nextSymbolIndex += 1

        const symbol = symbols[symbolIndex]

        if (symbol === undefined || !isCurrent()) {
          return
        }

        const symbolRangeKey = getRangeKey(symbol.declarationRange)

        if (suppressedRanges.has(symbolRangeKey)) {
          continue
        }

        const releaseReferenceLookup = await this.referenceLookupLimiter.acquire(
          isCurrent,
          token
        )

        if (releaseReferenceLookup === undefined) {
          return
        }

        if (!isCurrent()) {
          releaseReferenceLookup()

          return
        }

        let locations: Location[] | undefined

        try {
          locations = await this.executeCommand<Location[]>(
            'vscode.executeReferenceProvider',
            document.uri,
            symbol.referencePosition
          )
        } catch (error: unknown) {
          logErrorOnce(error)
          continue
        } finally {
          releaseReferenceLookup()
        }

        if (!isCurrent()) {
          return
        }

        if (locations === undefined || locations.length === 0) {
          reportIncomplete()
          continue
        }

        const fallbackDeclarationIdentity = getDeclarationIdentityKey(symbol)

        const declarationGroupKey = getDeclarationGroupKey(
          document.uri,
          locations,
          declarationIdentitiesByRange,
          suppressedRanges,
          fallbackDeclarationIdentity
        )

        if (declarationGroupKey === undefined) {
          continue
        }

        const suppressionLine = suppressionLines.get(symbol.range.start.line)

        candidates[symbolIndex] = {
          declarationGroupKey,

          finding: {
            declarationRange: symbol.declarationRange,
            name: symbol.name,
            range: symbol.range,
            suppressionLine
          }
        }
      }
    }

    const workerCount = Math.min(referenceConcurrency, symbols.length)
    const workers = Array.from({ length: workerCount }, runWorker)

    await Promise.all(workers)

    return candidates
  }

  private isAnalysisCurrent(
    document: TextDocument,
    identity: AnalysisIdentity,
    token: CancellationToken
  ): boolean {
    const isCurrent = !this.isDisposed
      && !document.isClosed
      && document.version === identity.documentVersion
      && this.graphEpoch === identity.graphEpoch
      && this.configurationEpoch === identity.configurationEpoch
      && !token.isCancellationRequested

    return isCurrent
  }
}

function hasSameIdentity(
  cacheEntry: AnalysisIdentity,
  identity: AnalysisIdentity
): boolean {
  const hasMatchingIdentity = cacheEntry.documentVersion === identity.documentVersion
    && cacheEntry.graphEpoch === identity.graphEpoch
    && cacheEntry.configurationEpoch === identity.configurationEpoch

  return hasMatchingIdentity
}

function cancelledResult(): AnalysisResult {
  return {
    findings: [],
    status: 'cancelled'
  }
}

function getUniqueFindings(
  candidates: readonly (FindingCandidate | null)[]
): readonly ZeroReferenceFinding[] {
  const seenDeclarationGroups = new Set<string>()
  const findings: ZeroReferenceFinding[] = []

  for (const candidate of candidates) {
    if (candidate === null
      || seenDeclarationGroups.has(candidate.declarationGroupKey)) {
      continue
    }

    seenDeclarationGroups.add(candidate.declarationGroupKey)
    findings.push(candidate.finding)
  }

  return findings
}

function getDeclarationIdentitiesByRange(
  symbols: readonly SymbolData[]
): ReadonlyMap<string, ReadonlySet<string>> {
  const identitiesByRange = new Map<string, Set<string>>()

  for (const symbol of symbols) {
    const rangeKey = getRangeKey(symbol.declarationRange)
    const identities = identitiesByRange.get(rangeKey) ?? new Set<string>()

    identities.add(getDeclarationIdentityKey(symbol))
    identitiesByRange.set(rangeKey, identities)
  }

  return identitiesByRange
}

function getDeclarationIdentityKey(symbol: SymbolData): string {
  const identityKey = `${symbol.kind}:${symbol.normalizedName}`

  return identityKey
}

function getDeclarationGroupKey(
  documentUri: Uri,
  locations: readonly Location[] | undefined,
  declarationIdentitiesByRange: ReadonlyMap<string, ReadonlySet<string>>,
  suppressedRanges: ReadonlySet<string>,
  declarationIdentityKey: string
): string | undefined {
  if (locations === undefined || locations.length === 0) {
    return
  }

  const locationKeys = new Set<string>()

  for (const location of locations) {
    const locationKey = getRangeKey(location.range)
    const declarationIdentities = declarationIdentitiesByRange.get(locationKey)

    if (location.uri.toString() !== documentUri.toString()
      || suppressedRanges.has(locationKey)
      || !declarationIdentities?.has(declarationIdentityKey)) {
      return
    }

    locationKeys.add(locationKey)
  }

  const sortedLocationKeys = [...locationKeys].sort()
  const declarationGroupKey = sortedLocationKeys.join('|')

  return declarationGroupKey
}

function getRangeKey(range: Range): string {
  const rangeKey = `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`

  return rangeKey
}

class ConcurrencyLimiter {
  private activeCount = 0
  private readonly pendingAcquisitions: PendingAcquisition[] = []

  constructor(private readonly maximumCount: number) {}

  acquire(
    isCurrent: () => boolean,
    token: CancellationToken
  ): Promise<(() => void) | undefined> {
    if (!isCurrent()) {
      return Promise.resolve(undefined)
    }

    if (this.activeCount < this.maximumCount) {
      this.activeCount += 1

      const release = this.createRelease()

      return Promise.resolve(release)
    }

    return new Promise(resolve => {
      const acquisition: PendingAcquisition = {
        cancellationSubscription: undefined,
        isCurrent,
        resolve
      }

      this.pendingAcquisitions.push(acquisition)

      const cancellationSubscription = token.onCancellationRequested(() => {
        this.cancelPendingAcquisition(acquisition)
      })

      acquisition.cancellationSubscription = cancellationSubscription

      if (!isCurrent()) {
        this.cancelPendingAcquisition(acquisition)
      }
    })
  }

  private cancelPendingAcquisition(acquisition: PendingAcquisition): void {
    const acquisitionIndex = this.pendingAcquisitions.indexOf(acquisition)

    acquisition.cancellationSubscription?.dispose()
    acquisition.cancellationSubscription = undefined

    if (acquisitionIndex === -1) {
      return
    }

    this.pendingAcquisitions.splice(acquisitionIndex, 1)
    acquisition.resolve(undefined)
  }

  private getNextCurrentAcquisition(): PendingAcquisition | undefined {
    while (this.pendingAcquisitions.length > 0) {
      const acquisition = this.pendingAcquisitions.shift()

      if (acquisition === undefined) {
        return
      }

      acquisition.cancellationSubscription?.dispose()
      acquisition.cancellationSubscription = undefined

      if (!acquisition.isCurrent()) {
        acquisition.resolve(undefined)

        continue
      }

      return acquisition
    }

    return
  }

  private createRelease(): () => void {
    let hasReleased = false

    return () => {
      if (hasReleased) {
        return
      }

      hasReleased = true

      const nextAcquisition = this.getNextCurrentAcquisition()

      if (nextAcquisition === undefined) {
        this.activeCount -= 1

        return
      }

      const release = this.createRelease()

      nextAcquisition.resolve(release)
    }
  }
}
