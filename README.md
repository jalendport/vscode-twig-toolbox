# Twig Toolbox

Twig language support for VS Code: syntax highlighting and a real language server, with first-class
CraftCMS awareness.

> **Status:** pre-release (0.x). Nothing is published to the marketplaces yet.

## Features

- Syntax highlighting for `.twig` and `.html.twig`
- Syntax diagnostics, context-aware completions, hover docs and signature help
- Embedded HTML and CSS: tag/attribute completions, hover, auto-closing tags, matching-tag
  highlights, and CSS completions in `<style>` blocks and inline `style=""` attributes

## HTML, CSS and Emmet

A Twig file is an HTML file, so HTML and CSS support is built in — no companion extension needed.
Twig constructs are masked out of a shadow copy of the document before VS Code's own HTML and CSS
language services see it, so `{{ … }}` and `{% … %}` get Twig completions while everything around
them gets HTML.

**Emmet works out of the box.** The extension contributes

```jsonc
"emmet.includeLanguages": { "twig": "html" }
```

as a default, and VS Code merges object settings key by key — so this holds even if you have your own
`emmet.includeLanguages`. You only need to add the mapping yourself if you have explicitly set `twig`
to something else:

```jsonc
"emmet.includeLanguages": {
  "twig": "html"
}
```

Auto-closing tags and attribute quotes can be turned off with `twigToolbox.autoClosingTags` and
`twigToolbox.autoCreateQuotes`.

### Known limitations

- JavaScript inside `<script>` is highlighted but gets no IntelliSense — no completions, hover or
  diagnostics. Full JS support in `<script>` is out of scope.
- HTML formatting is not provided.

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
