import { CodeAction, CodeActionKind, EndOfLine, Position, WorkspaceEdit } from 'vscode'
import type { CancellationToken, CodeActionContext, CodeActionProvider, Range, TextDocument } from 'vscode'
import type { ZeroReferenceAnalyzer } from './analysis.js'
import { getUseCodeLens } from './config.js'
import { suppressionComment } from './suppression.js'

export class ZeroReferenceCodeActionProvider implements CodeActionProvider {
  constructor(
    private readonly analyzer: ZeroReferenceAnalyzer,
    private readonly isEnabled: () => boolean = getUseCodeLens
  ) {}

  provideCodeActions(
    document: TextDocument,
    range: Range,
    context: CodeActionContext,
    token: CancellationToken
  ): CodeAction[] {
    if (!this.isEnabled()
      || token.isCancellationRequested
      || (context.only !== undefined && !context.only.contains(CodeActionKind.QuickFix))) {
      return []
    }

    const findings = this.analyzer.getCachedFindings(document, token)

    const matchingFindings = findings.filter(finding => {
      const intersection = finding.declarationRange.intersection(range)

      return intersection !== undefined && (range.isEmpty || !intersection.isEmpty)
    })

    const finding = matchingFindings[0]

    if (matchingFindings.length !== 1 || finding?.suppressionLine === undefined) {
      return []
    }

    const line = document.lineAt(finding.suppressionLine)
    const indentation = line.text.slice(0, line.firstNonWhitespaceCharacterIndex)
    const newline = document.eol === EndOfLine.CRLF ? '\r\n' : '\n'
    const text = `${indentation}${suppressionComment}${newline}`
    const position = new Position(finding.suppressionLine, 0)
    const edit = new WorkspaceEdit()

    edit.insert(document.uri, position, text)

    const action = new CodeAction('Zero Reference: Ignore this symbol', CodeActionKind.QuickFix)

    action.edit = edit

    return [action]
  }
}
