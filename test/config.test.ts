import { strict as assert } from 'node:assert';
import {
  commands,
  ConfigurationTarget,
  extensions,
  workspace
} from 'vscode';
import {
  registerUseCodeLensListener
} from '../src/config.js';

suite('useCodeLens configuration', () => {
  suiteSetup(async () => {
    const extension = extensions.all.find(candidate =>
      candidate.packageJSON.name === 'zero-reference'
    );

    assert.ok(extension !== undefined);
    await extension.activate();
  });

  teardown(async () => {
    const configuration = workspace.getConfiguration('zeroReference');

    await configuration.update('useCodeLens', undefined, ConfigurationTarget.Workspace);
    await configuration.update('useCodeLens', undefined, ConfigurationTarget.Global);
  });

  test('toggle command preserves and updates an existing workspace override', async () => {
    const configuration = workspace.getConfiguration('zeroReference');

    await configuration.update('useCodeLens', false, ConfigurationTarget.Global);
    await configuration.update('useCodeLens', true, ConfigurationTarget.Workspace);

    await commands.executeCommand('zeroReference.toggleCodeLens');

    let inspection = configuration.inspect<boolean>('useCodeLens');

    assert.equal(inspection?.globalValue, false);
    assert.equal(inspection?.workspaceValue, false);

    await commands.executeCommand('zeroReference.toggleCodeLens');

    inspection = configuration.inspect<boolean>('useCodeLens');
    assert.equal(inspection?.globalValue, false);
    assert.equal(inspection?.workspaceValue, true);
  });

  test('a direct setting update emits exactly one refresh notification', async () => {
    const configuration = workspace.getConfiguration('zeroReference');
    const change = createDeferred<void>();
    let refreshCount = 0;
    const listener = registerUseCodeLensListener(() => {
      refreshCount += 1;
      change.resolve();
    });

    try {
      await configuration.update('useCodeLens', false, ConfigurationTarget.Workspace);
      await change.promise;
      await delay(25);

      assert.equal(refreshCount, 1);
    } finally {
      listener.dispose();
    }
  });
});

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>(resolve => {
    resolvePromise = resolve;
  });

  assert.ok(resolvePromise !== undefined);
  return { promise, resolve: resolvePromise };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, milliseconds);
  });
}
