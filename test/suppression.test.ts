import { strict as assert } from 'node:assert'
import { Location, Range, WorkspaceEdit, workspace } from 'vscode'
import { createAnalysisHarness } from './analysisHarness.js'

suite('declaration suppression', () => {
  for (const language of ['typescript', 'typescriptreact', 'javascript', 'javascriptreact']) {
    test(`skips only the suppressed declaration before reference lookup in ${language}`, async () => {
      const document = await workspace.openTextDocument({
        content: '// zero-reference-ignore-next-line\nexport function entry() {}\nexport function neighbor() {}',
        language
      })

      const harness = createAnalysisHarness(document)

      try {
        const findings = await harness.analyzer.analyze(document, harness.cancellation.token)

        assert.deepEqual(findings.map(finding => finding.name), ['neighbor'])
        assert.deepEqual(harness.counts.referenceNames, ['neighbor'])

        const edit = new WorkspaceEdit()

        edit.delete(document.uri, new Range(0, 0, 1, 0))
        assert.equal(await workspace.applyEdit(edit), true)

        const restored = await harness.analyzer.analyze(document, harness.cancellation.token)

        assert.deepEqual(restored.map(finding => finding.name).sort(), ['entry', 'neighbor'])
        assert.equal(harness.counts.documentSymbolCalls, 2)
        assert.equal(harness.counts.referenceNames.length, 3)
      } finally {
        harness.dispose()
      }
    })
  }

  test('supports variable spans beginning after declaration keywords', async () => {
    const document = await workspace.openTextDocument({
      content: '// zero-reference-ignore-next-line\nexport const entry = 1;\nexport const neighbor = 2;',
      language: 'typescript'
    })

    const harness = createAnalysisHarness(document)

    try {
      const findings = await harness.analyzer.analyze(document, harness.cancellation.token)

      assert.deepEqual(findings.map(finding => finding.name), ['neighbor'])
      assert.deepEqual(harness.counts.referenceNames, ['neighbor'])
    } finally {
      harness.dispose()
    }
  })

  for (const language of ['typescript', 'typescriptreact', 'javascript', 'javascriptreact']) {
    test(`binds a directive to split variable declaration keywords in ${language}`, async () => {
      const document = await workspace.openTextDocument({
        content: '// zero-reference-ignore-next-line\nexport const\n  entry = 1;\nconst neighbor = 2;',
        language
      })

      const harness = createAnalysisHarness(document)

      try {
        const suppressed = await harness.analyzer.analyze(document, harness.cancellation.token)

        assert.deepEqual(suppressed.map(finding => finding.name), ['neighbor'])
        assert.deepEqual(harness.counts.referenceNames, ['neighbor'])

        const edit = new WorkspaceEdit()

        edit.delete(document.uri, new Range(0, 0, 1, 0))
        assert.equal(await workspace.applyEdit(edit), true)

        const restored = await harness.analyzer.analyze(document, harness.cancellation.token)
        const entry = restored.find(finding => finding.name === 'entry')

        assert.ok(entry !== undefined)
        assert.equal(entry.suppressionLine, 0)
        assert.deepEqual(restored.map(finding => finding.name).sort(), ['entry', 'neighbor'])
        assert.equal(harness.counts.referenceNames.length, 3)

        const misplaced = new WorkspaceEdit()

        misplaced.insert(document.uri, new Range(1, 0, 1, 0).start, '// zero-reference-ignore-next-line\n')
        assert.equal(await workspace.applyEdit(misplaced), true)

        const stillVisible = await harness.analyzer.analyze(document, harness.cancellation.token)

        assert.ok(stillVisible.some(finding => finding.name === 'entry'))
        assert.equal(harness.counts.referenceNames.length, 5)
      } finally {
        harness.dispose()
      }
    })

    for (const declaration of ['function entry() {}', 'class entry {}']) {
      test(`rejects a multiline ${declaration} expression in ${language}`, async () => {
        const content = ['const outer = (', '// zero-reference-ignore-next-line', declaration, ');'].join('\n')

        const document = await workspace.openTextDocument({
          content,
          language
        })

        const harness = createAnalysisHarness(document)

        try {
          const findings = await harness.analyzer.analyze(document, harness.cancellation.token)
          const entry = findings.find(finding => finding.name === 'entry')

          assert.ok(entry !== undefined)
          assert.equal(entry.suppressionLine, undefined)
          assert.ok(harness.counts.referenceNames.includes('entry'))

          const calls = harness.counts.referenceNames.length
          const edit = new WorkspaceEdit()

          edit.delete(document.uri, new Range(1, 0, 2, 0))
          assert.equal(await workspace.applyEdit(edit), true)

          const withoutDirective = await harness.analyzer.analyze(document, harness.cancellation.token)
          const visibleEntry = withoutDirective.find(finding => finding.name === 'entry')

          assert.ok(visibleEntry !== undefined)
          assert.equal(visibleEntry.suppressionLine, undefined)
          assert.equal(harness.counts.referenceNames.length, calls * 2)
        } finally {
          harness.dispose()
        }
      })
    }
  }

  for (const opening of ['function outer() {', 'const outer = () => {', 'const outer = function () {']) {
    test(`preserves nested statement suppression inside ${opening}`, async () => {
      const content = [opening, '  // zero-reference-ignore-next-line', '  function entry() {}', '};'].join('\n')

      const document = await workspace.openTextDocument({
        content,
        language: 'typescript'
      })

      const harness = createAnalysisHarness(document)

      try {
        const suppressed = await harness.analyzer.analyze(document, harness.cancellation.token)

        assert.deepEqual(suppressed.map(finding => finding.name), ['outer'])
        assert.deepEqual(harness.counts.referenceNames, ['outer'])

        const edit = new WorkspaceEdit()

        edit.delete(document.uri, new Range(1, 0, 2, 0))
        assert.equal(await workspace.applyEdit(edit), true)

        const restored = await harness.analyzer.analyze(document, harness.cancellation.token)
        const entry = restored.find(finding => finding.name === 'entry')

        assert.equal(entry?.suppressionLine, 1)
        assert.equal(harness.counts.referenceNames.length, 3)
      } finally {
        harness.dispose()
      }
    })
  }

  test('supports JSDoc followed by suppression before decorators', async () => {
    const document = await workspace.openTextDocument({
      content: [
        'class Owner {',
        '  /** Entry point documentation. */',
        '  // zero-reference-ignore-next-line',
        '  @decorator',
        '  entry() {}',
        '  neighbor() {}',
        '}'
      ].join('\n'),

      language: 'typescript'
    })

    const harness = createAnalysisHarness(document)

    try {
      const findings = await harness.analyzer.analyze(document, harness.cancellation.token)

      assert.deepEqual(findings.map(finding => finding.name).sort(), ['Owner', 'neighbor'])
      assert.equal(harness.counts.referenceNames.includes('entry'), false)

      const edit = new WorkspaceEdit()

      edit.delete(document.uri, new Range(2, 0, 3, 0))
      assert.equal(await workspace.applyEdit(edit), true)

      const restored = await harness.analyzer.analyze(document, harness.cancellation.token)
      const entry = restored.find(finding => finding.name === 'entry')

      assert.equal(entry?.suppressionLine, 2)
    } finally {
      harness.dispose()
    }
  })

  for (const declaration of ['class Owner', 'namespace Owner']) {
    test(`does not suppress members with their ${declaration}`, async () => {
      const member = declaration.startsWith('class') ? '  member = 1;' : '  export const member = 1;'
      const content = `// zero-reference-ignore-next-line\n${declaration} {\n${member}\n}`

      const document = await workspace.openTextDocument({
        content,
        language: 'typescript'
      })

      const harness = createAnalysisHarness(document)

      try {
        const findings = await harness.analyzer.analyze(document, harness.cancellation.token)

        assert.deepEqual(findings.map(finding => finding.name), ['member'])
        assert.deepEqual(harness.counts.referenceNames, ['member'])
      } finally {
        harness.dispose()
      }
    })
  }

  for (const declarations of [
    ['function entry(value: string): string;', 'function entry(value: number): number;', 'function entry(value: unknown) { return value; }'],
    ['interface entry {}', 'interface entry {}']
  ]) {
    test(`suppresses the confirmed group for ${declarations[0]}`, async () => {
      const lines = declarations.slice()

      lines.splice(1, 0, '// zero-reference-ignore-next-line')

      const document = await workspace.openTextDocument({
        content: lines.join('\n'),
        language: 'typescript'
      })

      const harness = createAnalysisHarness(document, (symbol, symbols) => {
        return symbols.filter(candidate => candidate.normalizedName === symbol.normalizedName)
          .map(candidate => new Location(document.uri, candidate.declarationRange))
      })

      try {
        const suppressed = await harness.analyzer.analyze(document, harness.cancellation.token)

        assert.deepEqual(suppressed, [])
        assert.equal(harness.counts.referenceNames.length, declarations.length - 1)

        const edit = new WorkspaceEdit()

        edit.delete(document.uri, new Range(1, 0, 2, 0))
        assert.equal(await workspace.applyEdit(edit), true)

        const restored = await harness.analyzer.analyze(document, harness.cancellation.token)

        assert.deepEqual(restored.map(finding => finding.name), ['entry'])
        assert.equal(harness.counts.referenceNames.length, 2 * declarations.length - 1)
      } finally {
        harness.dispose()
      }
    })
  }

  for (const gap of ['', '// Another comment.', '/** Documentation. */']) {
    test(`does not cross an intervening line: ${JSON.stringify(gap)}`, async () => {
      const content = `// zero-reference-ignore-next-line\n${gap}\nfunction entry() {}`

      const document = await workspace.openTextDocument({
        content,
        language: 'typescript'
      })

      const harness = createAnalysisHarness(document)

      try {
        const findings = await harness.analyzer.analyze(document, harness.cancellation.token)

        assert.deepEqual(findings.map(finding => finding.name), ['entry'])
        assert.deepEqual(harness.counts.referenceNames, ['entry'])
      } finally {
        harness.dispose()
      }
    })
  }

  for (const [label, content, language] of [
    ['template literal', 'const text = `\n// zero-reference-ignore-next-line\n${function entry() {}}\n`;', 'typescript'],
    ['block comment', '/*\n// zero-reference-ignore-next-line\n*/ function entry() {}', 'typescript'],
    ['JSX text', 'const markup = <div>\n// zero-reference-ignore-next-line\n{function entry() {}}\n</div>;', 'typescriptreact']
  ]) {
    test(`does not interpret directive text inside ${label}`, async () => {
      assert.ok(content !== undefined && language !== undefined)

      const document = await workspace.openTextDocument({
        content,
        language
      })

      const harness = createAnalysisHarness(document)

      try {
        const findings = await harness.analyzer.analyze(document, harness.cancellation.token)
        const entry = findings.find(finding => finding.name === 'entry')

        assert.ok(entry !== undefined)
        assert.equal(entry.suppressionLine, undefined)
        assert.ok(harness.counts.referenceNames.includes('entry'))
      } finally {
        harness.dispose()
      }
    })
  }

  test('rejects suppression and insertion for multiple declarations on one line', async () => {
    const document = await workspace.openTextDocument({
      content: '// zero-reference-ignore-next-line\nconst first = 1, second = 2;',
      language: 'typescript'
    })

    const harness = createAnalysisHarness(document)

    try {
      const findings = await harness.analyzer.analyze(document, harness.cancellation.token)

      assert.deepEqual(findings.map(finding => finding.name).sort(), ['first', 'second'])
      assert.ok(findings.every(finding => finding.suppressionLine === undefined))
      assert.equal(harness.counts.referenceNames.length, 2)
    } finally {
      harness.dispose()
    }
  })
})
