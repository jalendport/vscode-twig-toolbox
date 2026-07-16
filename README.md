# Twig Toolbox

Twig language support for VS Code: syntax highlighting and a real language server, with first-class
CraftCMS awareness.

> **Status:** pre-release (0.x). Nothing is published to the marketplaces yet.

## Features

- Syntax highlighting for `.twig` and `.html.twig`
- A language server that starts on Twig files (no language features yet)

## Development

The repo is an npm-workspaces monorepo:

| Package                    | Purpose                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/extension`       | VS Code client: activation, language client wiring, contributions. This is the publishable package. |
| `packages/language-server` | LSP server: features, dialect packs, project introspection.                                         |
| `packages/parser`          | Standalone tolerant Twig lexer/parser/AST, with no `vscode` dependency.                             |

The TextMate grammar (`syntaxes/`), `language-configuration.json`, and `images/` live at the repo
root and are copied into `packages/extension` by the build, since `vsce` can only package files
inside the extension package.

```sh
npm install
npm run build      # typecheck + bundle client and server into packages/extension/dist
npm run watch      # rebuild on change
npm test           # vitest
npm run lint       # eslint + prettier --check
npm run package    # produce a .vsix in the repo root
```

Press <kbd>F5</kbd> ("Run Extension") to launch an Extension Development Host. Use the
"Extension + Server" compound to also attach a debugger to the language server.
