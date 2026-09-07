Zero Reference
==============

Highlight parts of code with no references in [Visual Studio Code](https://github.com/microsoft/vscode).

Preview
-------

![Screenshot](images/preview.gif)

Supported Languages
-------------------

* TypeScript
* JavaScript (note about [jsconfig.json](https://code.visualstudio.com/docs/languages/jsconfig))

Conservative Matching
---------------------

Properties are analyzed only when Visual Studio Code reports them as direct class or interface members. Default export assignments are also ignored because their consumers can live outside the static reference graph.

Zero references describes the current workspace reference graph, not proof that code is unused everywhere. External consumers and dynamic calls may not be visible to the language provider.

Workspace Scan
--------------

Run **Zero Reference: Scan Workspace** from the Command Palette to check TypeScript and JavaScript files in every workspace folder, including files that are not open in an editor. The scan supports `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs`. It runs only when requested and works even with CodeLens disabled.

The progress notification shows the current file and supports cancellation. Documents are loaded without opening editor tabs or saving changes; files already open are analyzed using their current unsaved text. Untitled documents and files outside the workspace are not included.

The scan respects `files.exclude`, `zeroReference.exclude`, and suppression comments, and always skips `.git` and `node_modules` directories. It follows VS Code's file-search API: `search.exclude` and `.gitignore` are not applied automatically. Use the existing exclusion settings for generated files. References from excluded files still count.

Results appear together in **Problems**, with the source **Zero Reference**. Each information-level entry navigates to the declaration name and uses the theme's unnecessary-code presentation. Enable the Problems panel's information filter if these entries are hidden. The summary reports checked, skipped, and incompletely checked files and findings; files omitted by the initial file search are not counted as skipped. Provider failures and unresolved references make the scan incomplete rather than claiming that the project is clean. **Show Output** opens the detailed log, including original provider errors.

Results are a snapshot of the last scan, kept in memory for this window even when documents close. After code changes, entries for changed, deleted, or renamed files are removed. Other entries say **Results from a previous scan; run Scan Workspace to update** and stop fading code until another scan finishes. Changing exclusions or workspace folders clears the snapshot. Toggling CodeLens does not affect it.

A new scan replaces the previous snapshot only after its file traversal finishes, including when there are no findings. Cancellation or file-discovery failure keeps the previous snapshot. Editing the reference graph during a scan cancels it to avoid combining different project states. Already-issued provider requests may finish after cancellation, but their results cannot overwrite the snapshot.

Run **Zero Reference: Clear Workspace Scan Results** to cancel any active scan and remove its findings. Re-running **Scan Workspace** cancels the previous run. **Zero Reference: Refresh** invalidates analysis and marks scan results as outdated; it does not automatically scan the workspace. Quick Fix continues to use only current cached analysis, never an outdated scan entry. No scan runs in the background automatically, and no code is deleted.

Exclusions and Suppression
--------------------------

Use `zeroReference.exclude` to skip declarations in selected files:

```json
{
  "zeroReference.exclude": ["generated/**", "**/*.generated.ts"]
}
```

Patterns use VS Code glob syntax and are relative to the file's workspace folder, including in multi-root workspaces. User, workspace, and folder settings follow VS Code's normal precedence. The default is an empty array; editor CodeLens does not apply `files.exclude`, while workspace scans use it during file discovery. Files outside a workspace folder are not excluded from editor analysis. References **from** excluded files still count when analyzing other files.

To suppress one declaration, place this comment immediately before its declaration line:

```ts
// zero-reference-ignore-next-line
export function externalEntryPoint() {}
```

Place the comment after JSDoc and before the first decorator, if present. Blank lines or other comments between the directive and declaration break the suppression. Suppressing a class or namespace does not suppress its members; suppressing an overload or merged declaration hides its whole confirmed declaration group.

If declaration keywords span multiple lines (for example, `export const` followed by the variable name on the next line), place the directive before the first keyword. Quick Fix uses that same line and its indentation, not the variable name's line.

With the cursor on a reported declaration's name, open VS Code's Quick Fix menu and choose **Zero Reference: Ignore this symbol**. The action uses current cached findings and inserts the comment without saving the file. Undo the edit or remove the comment to restore analysis. No action is offered while analysis is pending, when CodeLens is disabled, or when the selection covers multiple findings.

Suppression requires an unambiguous declaration-line boundary. Multiple declarations on the same line and declarations embedded in expressions must be moved onto separate declaration lines before suppression or the Quick Fix is available. Directive text inside strings, JSX text, or block comments is not a suppression comment.

Invalid exclusion settings are reported in the **Zero Reference** output channel. Invalid array entries are skipped; a non-array value falls back to no exclusions.

Installation
------------

[How to install VSCode extensions](https://code.visualstudio.com/docs/editor/extension-gallery)

Development
-----------

Development requires Node.js 24 and Visual Studio Code 1.125 or newer.

Install dependencies, build the extension, and create a VSIX package with Vite+:

```sh
vp install --frozen-lockfile
vp run test
vp run build
vp run package
```

Releases are prepared by Release Please and published by GitHub Actions. If the
`VSCE_PAT` secret expires:

1. [Create or regenerate the Azure DevOps PAT](https://dev.azure.com/ky6uk/_usersSettings/tokens)
   for the `ky6uk` organization with the `Marketplace (Manage)` scope.
2. [Replace the `VSCE_PAT` GitHub Actions secret](https://github.com/Perdolique/vscode-zero-reference/settings/secrets/actions).

Never commit the token to the repository.

License
-------

MIT License © Roman Nuritdinov (Ky6uk)
