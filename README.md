# Twig Toolbox

Twig language support for VS Code: a complete Twig 3 grammar and a real language server —
completions, hover, go-to-template and diagnostics — with first-class Craft CMS awareness.

> **Status:** pre-release (0.x). Nothing is published to the marketplaces yet.
>
> The five feature GIFs below are **placeholder slots** and do not render yet — each is marked with
> a `<!-- MEDIA: … -->` comment and specified in [docs/media-checklist.md](docs/media-checklist.md).
> They must be recorded and committed before 1.0.0 ships, or the marketplace listing will show
> broken images.

- **A real parser, not regexes.** A hand-rolled, error-tolerant Twig 3 parser that never gives up
  on half-typed code — because half-typed code is what you have while typing.
- **Completions that know where you are.** `{%` offers tags, `|` offers filters, `is` offers tests.
  Driven by the AST, not a word list.
- **HTML and CSS included.** A Twig file is an HTML file. Tag completions, attributes, Emmet and
  CSS all work, with no companion extension.
- **It learns your Craft project.** Reads `config/project/` and completes your _actual_ section,
  field and entry-type handles.
- **No telemetry.** No data collection, no network requests. [See below](#telemetry).

## Features

### Syntax highlighting

Every Twig 3 tag, filter, function, test and operator, correctly embedded in HTML — including the
cases other Twig extensions drop: Twig inside HTML attributes, `#{…}` interpolation inside strings,
and `<style>` / `<script>` blocks.

<!-- MEDIA: replace with images/demo-highlighting.gif — see docs/media-checklist.md #1 -->

![Syntax highlighting](images/demo-highlighting.gif)

### Completions

What you're offered depends on where the cursor sits in the AST:

| Where you are       | What you get                      |
| ------------------- | --------------------------------- |
| `{% ‸ %}`           | Tag names                         |
| `{{ value\|‸ }}`    | Filters                           |
| `{{ ‸ }}`           | Functions, and variables in scope |
| `{{ value is ‸ }}`  | Tests                             |
| `{% include '‸' %}` | Template paths                    |
| `{{ craft.‸ }}`     | The Craft API                     |
| `<div ‸>`           | HTML attributes                   |

Variables in scope means what it says: `{% set %}` values, `{% for %}` loop variables, and macro
parameters.

<!-- MEDIA: replace with images/demo-completions.gif — see docs/media-checklist.md #2 -->

![Context-aware completions](images/demo-completions.gif)

### Hover and signature help

Hover any tag, filter, function, test or global for its signature, parameter documentation,
deprecation notices, and a link to the upstream docs. Signature help follows you through arguments
as you type them.

<!-- MEDIA: replace with images/demo-hover.gif — see docs/media-checklist.md #3 -->

![Hover documentation](images/demo-hover.gif)

### Template navigation

Path completion, go-to-definition (<kbd>F12</kbd>) and clickable links for `{% extends %}`,
`{% include %}`, `{% import %}`, `{% embed %}`, `{% from %}` and `{% use %}` — and for the
`include()`, `source()` and `block(…, 'template')` functions.

Go-to-definition also resolves imported macros and blocks defined in parent templates.

Variables a template never sets resolve too. When a template does `{% set heading = entry.title %}`
and then includes a partial, Twig hands that variable to the partial — so hovering or pressing
<kbd>F12</kbd> on `heading` inside the partial jumps to the `{% set %}` that defines it, following
the chain through nested includes and embeds. Include sites are read the way Twig reads them: a
`with { … }` key is itself a definition, and `only` stops the search, because the included template
genuinely cannot see the outer context. Where several templates include the same partial with the
same variable, every definition comes back and VS Code offers the choice. Nothing resolves to a
guess: if the variable's origin can't be established, there's no hover card and no jump — and this
never produces a diagnostic.

<!-- MEDIA: replace with images/demo-navigation.gif — see docs/media-checklist.md #4 -->

![Go to template](images/demo-navigation.gif)

### Diagnostics

Syntax errors are reported as you type, with ranges that point at the actual problem — an unclosed
`{% if %}` underlines the opening tag, not the end of the file.

Everything else is **off by default**. Unknown-name checks exist, but shipping them on would mean
false positives on every project with a plugin we don't know about, so you opt in
([see below](#diagnostics-1)).

### Craft CMS awareness

Detected automatically from `composer.json`. In a Craft project you additionally get every Craft
tag, filter, function, test and global, version-gated to Craft 4 or 5, plus the `craft.*` API
including element query chains.

`craft.app.*` is modelled too, class by class, so the chain keeps resolving and **every segment**
of it hovers with a link to the class reference for the version you're on:

```twig
{{ craft.app.request.queryString }}
{#     ↑      ↑         ↑ each one hovers, each one links #}

{{ craft.app.config.general.‸ }}
{#                          ↑ devMode, siteToken, and the rest of GeneralConfig #}
```

Then the good part: Twig Toolbox reads your `config/project/**/*.yaml` and completes **your**
handles.

```twig
{% set posts = craft.entries.section('‸') %}
{#                                   ↑ your real section handles #}

{{ entry.‸ }}
{#        ↑ your real custom field handles #}
```

Section, entry-type, asset-volume, global-set, category-group, tag-group and site handles all
complete, and go-to-definition on one opens the YAML that declares it.

<!-- MEDIA: replace with images/demo-craft.gif — see docs/media-checklist.md #5 -->

![Craft schema awareness](images/demo-craft.gif)

## How Craft detection works

No prompt, no setting — the extension works it out, per workspace folder:

1. **Is this Craft?** `composer.json` is read, and the project counts as Craft if `craftcms/cms` is
   in `require` or `require-dev`. Nothing else triggers it, so a plain-Twig project never sees a
   Craft completion.
2. **Which Craft?** The exact version comes from `composer.lock`. Without a lockfile, it's
   approximated from the `composer.json` constraint (`^5.0` → `5.0`).
3. **Version gating.** Craft 5 entries are hidden in a Craft 4 project and vice versa. If the
   version can't be determined at all (a `dev-main` constraint, say), gating is skipped and
   everything is offered — showing you slightly too much beats hiding what you need.
4. **Your schema.** `config/project/**/*.yaml` is read for real handles. No directory, or
   unparseable YAML, and this part quietly does nothing — the rest still works.
5. **Template roots.** A `define('CRAFT_TEMPLATES_PATH', …)` reachable from your project's
   entry points — the `craft` executable, a root `bootstrap.php`, or `index.php` under `web/`,
   `public/`, `public_html/` or `www/` — following `require`s a couple of hops, so a bootstrap
   in a custom location is found too. Literal paths and `CRAFT_BASE_PATH` / `dirname(__DIR__[, n])`
   / `__DIR__` expressions are understood, and a guess is only trusted when the directory
   exists; otherwise `templates/`. The `twigToolbox.templateRoots` setting overrides all of this.

Re-detected automatically when `composer.json`, `composer.lock`, a bootstrap file or anything
under `config/project/` changes.

Not a Craft project? Template roots fall back to Symfony's `templates/` if
`symfony/framework-bundle` is in your composer packages, then to `templates/` if it exists, then to
the workspace folder itself.

## Twig's own version

Twig gets the same treatment, in every project rather than just Craft ones. The version comes from
`composer.lock`'s `twig/twig` — nothing else, since a project rarely requires Twig directly and a
constraint is a floor rather than what Composer resolved — and it gates the same way: `|html_attr`
and friends arrived in Twig 3.24, so a Craft 4 project (which pins Twig 3.19) isn't offered them.
No lockfile, or no Twig in it, and nothing is gated at all. Hovering a name that was gated out
still works, and tells you which version has it.

## Settings

All settings are under `twigToolbox.*`. Those scoped **resource** can be set per workspace folder.

| Setting                                | Type                                    | Default | Scope    | What it does                                                                                                                  |
| -------------------------------------- | --------------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `twigToolbox.templateRoots`            | `string[]`                              | `[]`    | resource | Template root directories, relative to the workspace folder unless absolute. **Replaces** auto-detection when non-empty.      |
| `twigToolbox.diagnostics.unknownNames` | `off` \| `hint` \| `warning` \| `error` | `off`   | resource | Reports unknown tag, filter, function and test names. Also enables hint-level reporting of template paths that don't resolve. |
| `twigToolbox.diagnostics.ignoredNames` | `string[]`                              | `[]`    | resource | Names that unknown-name diagnostics ignore. Use for a plugin we don't ship a catalog for.                                     |
| `twigToolbox.autoClosingTags`          | `boolean`                               | `true`  | resource | Automatically closes HTML tags.                                                                                               |
| `twigToolbox.autoCreateQuotes`         | `boolean`                               | `true`  | resource | Adds quotes after typing `=` in an HTML attribute.                                                                            |
| `twigToolbox.trace.server`             | `off` \| `messages` \| `verbose`        | `off`   | window   | Traces client↔server LSP messages. For bug reports.                                                                           |

### Diagnostics

The policy is **zero false positives out of the box**, so the split is:

- **Always on:** syntax errors. These are facts about the parse — an unclosed tag is unclosed.
- **Off by default:** unknown names. A filter we've never heard of is usually _your plugin_, not
  your typo. Turn it on when you want it:

```jsonc
{
	"twigToolbox.diagnostics.unknownNames": "warning",
	// Names from a plugin we don't ship a catalog for.
	"twigToolbox.diagnostics.ignoredNames": ["seomatic", "sprig"],
}
```

## FAQ

### Does Emmet work?

Yes, out of the box. The extension contributes

```jsonc
"emmet.includeLanguages": { "twig": "html" }
```

as a default, and VS Code merges object settings key by key — so this holds even if you have your
own `emmet.includeLanguages`. You only need to set it yourself if you have explicitly mapped `twig`
to something else:

```jsonc
"emmet.includeLanguages": { "twig": "html" }
```

### What about `.html.twig`?

Handled. Both `.twig` and `.html.twig` are claimed as the `twig` language, so Symfony-style names
get identical treatment. You don't need a `files.associations` entry.

If another Twig extension has claimed `.html.twig`, disable it — or force the association:

```jsonc
"files.associations": { "*.html.twig": "twig" }
```

### Do monorepos and multi-root workspaces work?

Yes. Detection, catalogs, template roots and settings are all resolved **per workspace folder**, so
one window holding a Craft 4 site, a Craft 5 site and a plain Symfony app gives each the right
completions. Nested folders resolve to the closest enclosing root.

One caveat: workspace folders are read when the server starts, so **adding or removing a folder in
a running window needs a reload** (<kbd>Developer: Reload Window</kbd>) before the new folder is
understood.

If your templates live somewhere unusual, point at them per folder:

```jsonc
{
	"twigToolbox.templateRoots": ["src/Resources/views", "templates"],
}
```

### Do I need a separate HTML extension?

No. HTML and CSS support is built in. Twig constructs are masked out of a shadow copy of the
document before VS Code's own HTML and CSS language services see it, so `{{ … }}` and `{% … %}` get
Twig completions while everything around them gets HTML.

### Why is a filter I use reported as unknown?

It isn't, by default — unknown-name diagnostics are off. If you turned them on, the name is
probably from a plugin. Add it to `twigToolbox.diagnostics.ignoredNames`. Craft plugin catalogs
(SEOmatic, Sprig, Formie…) are planned for after 1.0.

### Is Twig 1 or 2 supported?

No. Twig Toolbox targets **Twig 3** semantics only. Craft 4 and 5 are both supported.

### Why does VS Code ask before opening docs.craftcms.com?

That's VS Code's link protection, and it applies to every extension — extensions cannot whitelist
domains for you (by design). Click **Trust docs.craftcms.com** the first time and you won't be
asked again. To pre-trust the documentation domains, run **"Manage Trusted Domains"** from the
command palette and add `*.craftcms.com` and `twig.symfony.com`.

### Does it work in Cursor and VSCodium?

Yes — it's published to [Open VSX](https://open-vsx.org/) as well as the VS Code Marketplace.

## Telemetry

**None.** Twig Toolbox collects no data, contains no analytics SDK, and makes **no network requests
at runtime**. Everything it knows ships inside the extension as pre-built JSON catalogs; everything
else it reads from your own files on disk.

The catalog generators in `scripts/` do clone Twig's and Craft's source at development time to
regenerate those catalogs. They are not part of the published extension and never run on your
machine.

## Known limitations

- JavaScript inside `<script>` is highlighted but gets no IntelliSense.
- No formatting, find-references, rename or outline in 1.0 — see the [changelog](CHANGELOG.md).
- `@namespace`-style template paths don't resolve.

## Contributing

Issues and PRs: <https://github.com/jalendport/vscode-twig-toolbox>.

The repo is an npm-workspaces monorepo:

| Package                    | Purpose                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/extension`       | VS Code client: activation, language client wiring, contributions. This is the publishable package. |
| `packages/language-server` | LSP server: features, dialect packs, project introspection.                                         |
| `packages/parser`          | Standalone tolerant Twig lexer/parser/AST, with no `vscode` dependency.                             |

The TextMate grammar (`syntaxes/`), `language-configuration.json`, `catalogs/` and `images/` live at
the repo root and are copied into `packages/extension` by the build, since `vsce` can only package
files inside the extension package.

```sh
npm install
npm run build      # typecheck + bundle client and server into packages/extension/dist
npm run watch      # rebuild on change
npm test           # vitest + grammar snapshots
npm run lint       # eslint + prettier --check
npm run bench      # performance report (see docs/perf-notes.md)
npm run package    # produce a .vsix in the repo root
```

Press <kbd>F5</kbd> ("Run Extension") to launch an Extension Development Host. Use the
"Extension + Server" compound to also attach a debugger to the language server.

Performance budgets are measured and enforced — see [docs/perf-notes.md](docs/perf-notes.md).
