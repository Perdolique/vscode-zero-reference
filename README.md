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

Installation
------------

[How to install VSCode extensions](https://code.visualstudio.com/docs/editor/extension-gallery)

Development
-----------

Install dependencies, build the extension, and create a VSIX package with Vite+:

```sh
vp install --frozen-lockfile
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
