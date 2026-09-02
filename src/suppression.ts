import { SymbolKind } from 'vscode'
import type { DocumentSymbol, Position, SymbolInformation, TextDocument } from 'vscode'

export const suppressionComment = '// zero-reference-ignore-next-line'

interface CodeLine {
  readonly line: number;
  readonly text: string;
}

const variablePrefix = /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var|using|await\s+using)\s+$/
const variableStart = /^[\t ]*(?:export[\t ]+)?(?:declare[\t ]+)?(?:const|let|var|using|await[\t ]+using)[\t ]+/
const declarationKeywords = new Set(['export', 'declare', 'await', 'const', 'let', 'var', 'using'])

/** Maps provider symbol-start lines to declaration lines shared by directives and Quick Fix edits. */
export function getSuppressionLines(
  symbols: readonly (DocumentSymbol | SymbolInformation)[],
  document: TextDocument
): ReadonlyMap<number, number> {
  const countsByLine = new Map<number, number>()
  const linesBySymbolLine = new Map<number, number>()
  const pending = Array.from(symbols)

  while (pending.length > 0) {
    const symbol = pending.pop()

    if (symbol === undefined) {
      continue
    }

    const range = 'selectionRange' in symbol ? symbol.range : symbol.location.range
    const line = range.start.line
    const count = countsByLine.get(line) ?? 0

    countsByLine.set(line, count + 1)

    const declarationLine = getDeclarationLine(document, range.start, symbol.kind)
    const isStatementStart = declarationLine !== undefined && hasStatementBoundary(document, declarationLine)

    if (isStatementStart) {
      linesBySymbolLine.set(line, declarationLine)
    }

    if ('children' in symbol) {
      for (const child of symbol.children) {
        pending.push(child)
      }
    }
  }

  for (const [line, count] of countsByLine) {
    if (count !== 1) {
      linesBySymbolLine.delete(line)
    }
  }

  return linesBySymbolLine
}

function getDeclarationLine(document: TextDocument, start: Position, kind: SymbolKind): number | undefined {
  let line = start.line
  const lineText = document.lineAt(line).text
  let prefix = lineText.slice(0, start.character)
  const startsLine = prefix.trim().length === 0

  if (kind !== SymbolKind.Variable) {
    return startsLine ? line : undefined
  }

  // Flat providers may include the keywords; TS/JS variable spans begin at the binding instead.
  if (startsLine) {
    const keywords = variableStart.exec(lineText)

    prefix = keywords?.[0] ?? prefix
  }

  // Recover only whitespace-separated keywords, never an initializer or another declarator.
  while (line > 0) {
    const previousText = document.lineAt(line - 1).text
    const trimmedText = previousText.trim()
    const words = trimmedText.split(/\s+/)
    const onlyKeywords = words.every(word => declarationKeywords.has(word))

    if (!onlyKeywords) {
      break
    }

    prefix = `${previousText}\n${prefix}`
    line -= 1
  }

  const hasVariableKeywords = variablePrefix.test(prefix)

  return hasVariableKeywords ? line : undefined
}

function hasStatementBoundary(document: TextDocument, line: number): boolean {
  const previous = getPreviousCodeLine(document, line)

  if (previous === undefined) {
    return true
  }

  // Mixed code/comments cannot prove a boundary without interpreting their lexical context.
  const hasMixedComments = /\/\/|\/\*|\*\//.test(previous.text)

  if (hasMixedComments) {
    return false
  }

  const opensBody = previous.text.endsWith('{')

  if (opensBody) {
    const beforeBrace = previous.text.slice(0, -1)
    let header = beforeBrace.trimEnd()

    if (header.length === 0) {
      const previousHeader = getPreviousCodeLine(document, previous.line)

      header = previousHeader?.text ?? ''
    }

    // Recognize block bodies, but not object literals, JSX braces or template interpolations.
    const bodyHeader = /(?:=>|\)(?:\s*:\s*[^{}]+)?)$/.test(header)
      || /\b(?:class|interface|namespace|module)\b[^{};=]*$/.test(header)
      || /^(?:try|else|do|finally)$/.test(header)

    return bodyHeader
  }

  const continuesExpression = /[([=,:?+*/%&|^!~<>.\-]$/.test(previous.text)
    || /\b(?:return|throw|yield|await|new|in|instanceof|typeof|void|delete|extends|of|case)$/.test(previous.text)

  return !continuesExpression
}

function getPreviousCodeLine(document: TextDocument, beforeLine: number): CodeLine | undefined {
  let inBlockComment = false

  for (let line = beforeLine - 1; line >= 0; line -= 1) {
    const lineText = document.lineAt(line).text
    let text = lineText.trim()

    while (text.length > 0) {
      if (inBlockComment) {
        const opening = text.lastIndexOf('/*')

        if (opening === -1) {
          break
        }

        const beforeComment = text.slice(0, opening)

        text = beforeComment.trimEnd()
        inBlockComment = false
        continue
      }

      const isLineComment = text.startsWith('//')

      if (isLineComment) {
        break
      }

      const endsBlockComment = text.endsWith('*/')

      if (endsBlockComment) {
        const beforeClosing = text.slice(0, -2)

        text = beforeClosing.trimEnd()
        inBlockComment = true
        continue
      }

      return {
        line,
        text
      }
    }
  }

  return
}

export function hasSuppressionComment(document: TextDocument, line: number): boolean {
  if (line === 0) {
    return false
  }

  const previousLine = document.lineAt(line - 1).text.trim()

  return previousLine === suppressionComment
}
