import { strict as assert } from 'node:assert';
import {
  commands,
  extensions,
  Uri,
  workspace
} from 'vscode';
import type { CodeLens } from 'vscode';

suite('extension integration', () => {
  test('classifies the TypeScript fixture conservatively', async () => {
    const extension = extensions.all.find(candidate =>
      candidate.packageJSON.name === 'zero-reference'
    );
    const workspaceFolder = workspace.workspaceFolders?.[0];

    assert.ok(extension !== undefined);
    assert.ok(workspaceFolder !== undefined);
    await extension.activate();

    const documentUri = Uri.joinPath(workspaceFolder.uri, 'fixture.ts');

    await workspace.openTextDocument(documentUri);

    const codeLenses = await commands.executeCommand<CodeLens[]>(
      'vscode.executeCodeLensProvider',
      documentUri
    );
    const titles = codeLenses?.flatMap(codeLens =>
      codeLens.command === undefined ? [] : [codeLens.command.title]
    ) ?? [];

    assert.equal(titles.filter(title => title.includes('MergedModel')).length, 1);
    assert.equal(titles.filter(title => title.includes('overloaded')).length, 1);
    assert.equal(titles.some(title => title.includes('["literal"]')), false);
    assert.equal(titles.some(title => title.includes('shorthandValue')), false);
  });
});
