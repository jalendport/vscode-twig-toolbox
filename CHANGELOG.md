# Change Log

All notable changes to the Twig Toolbox extension are documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

First public release. Twig Toolbox is a ground-up Twig 3 extension: a complete TextMate grammar
plus a real language server, with first-class Craft CMS awareness. Twig 3 semantics only; Craft 4
and 5 are both supported.

### Added

**Syntax highlighting**

- A complete TextMate grammar for Twig 3 — every tag, filter, function, test and operator —
  embedded correctly in HTML.
- Highlighting inside `<style>` and `<script>` blocks, through Twig in HTML attributes, and inside
  `#{…}` string interpolation.
- Language configuration: comment toggling, bracket matching, auto-closing pairs, indentation and
  folding for Twig blocks.
- `.twig` and `.html.twig` are both recognised as Twig.

**Language server**

- Syntax diagnostics from a hand-rolled, error-tolerant parser that never throws and keeps
  producing useful trees for the incomplete code every keystroke creates.
- Context-aware completions driven by where the cursor sits in the AST rather than by word lists:
  tag names, filters after `|`, functions, tests after `is`, and variables in scope.
- Hover documentation for tags, filters, functions, tests and globals — signature, parameter docs,
  deprecation notices and a link to the upstream documentation.
- Signature help while typing filter and function arguments.
- Twig version gating: the `twig/twig` version in `composer.lock` decides which of Twig's own
  tags, filters, functions and tests are offered, so a Craft 4 project (Twig 3.19) isn't shown
  what Twig 3.24 added. No lockfile, or no Twig in it, and nothing is gated. Hover still explains
  a name that was gated out, and says which version has it.

**HTML, CSS and Emmet**

- HTML tag and attribute completions, hover, auto-closing tags and matching-tag highlights inside
  Twig files, with no companion extension.
- CSS completions and hover in `<style>` blocks and inline `style=""` attributes.
- Emmet works out of the box via a contributed `emmet.includeLanguages` default.

**Template navigation**

- Template-root detection: Craft's `CRAFT_TEMPLATES_PATH`, Symfony's `templates/`, or the
  workspace folder — overridable with `twigToolbox.templateRoots`.
- Path completion, go-to-definition and clickable document links for `extends`, `include`,
  `import`, `embed`, `from` and `use`, and for `include()`, `source()` and `block(…, 'template')`.
- Cross-file symbol resolution for imported macros and parent-template blocks.
- Cross-template variable resolution: hover and go-to-definition for variables an including
  template passes down, walked through nested includes and embeds, honouring `with` and `only`.

**Craft CMS**

- Automatic Craft detection from `composer.json` — no configuration, no prompt.
- A generated catalog of Craft's Twig layer: every Craft tag, filter, function, test and global,
  version-gated across Craft 4 and 5, offered only in Craft projects. Gating is release-accurate
  where Craft's docs or its changelog say so — `randomString()` is known to have arrived in 5.9.0,
  not merely "some time in 5".
- Completions, hover and signature help for the `craft.*` API surface, including element query
  chains.
- Deep `craft.app.*` awareness: the application, its front-end services and what they return are
  modelled class by class, so `craft.app.request.queryString` and `craft.app.config.general.devMode`
  complete and chain. Every segment hovers, each linking to the class reference page that documents
  it — for the Craft major the project actually has installed.
- The element classes are modelled to the same depth: `craft\elements\Entry`, `Asset`, `User`,
  `Category`, `Tag`, `GlobalSet`, `Address` and the `craft\base\Element` they share. Globals are
  typed (`currentUser` is a `User`), element queries are typed by what they return
  (`craft.entries.one()` is an `Entry`), and chains cross freely between them — so
  `currentUser.photo.getDataUrl` and `craft.entries.one().author.photo.dataUrl` resolve on every
  segment. `.all()` yields a list, which the model deliberately does not type; the chain ends there
  and Twig's array access takes over.
- Project-config introspection: reads `config/project/**/*.yaml` and completes your project's real
  section, entry-type, asset-volume, global-set, category-group, tag-group and site handles, with
  go-to-definition into the YAML that declares them.
- Your custom fields are merged with Craft's own members on the same object, and typed by what the
  field yields: an Assets field is an `AssetQuery`, so `entry.myAssetsField.one().dataUrl` chains
  from your YAML into Craft's classes and back out. A handle that collides with a member Craft
  already has wins the completion — in your project, that name is your field — while hover keeps
  Craft's documentation link for it.

**Settings**

- `twigToolbox.templateRoots`, `twigToolbox.diagnostics.unknownNames`,
  `twigToolbox.diagnostics.ignoredNames`, `twigToolbox.autoClosingTags`,
  `twigToolbox.autoCreateQuotes` and `twigToolbox.trace.server`.

### Notes

- **Telemetry: none.** No data collection and no network requests at runtime.
- Unknown-name diagnostics ship **off** by default, for zero false positives out of the box. Raise
  `twigToolbox.diagnostics.unknownNames` to `hint`, `warning` or `error` to opt in; the setting
  also enables hint-level reporting of unresolvable template paths.
- Not in 1.0: formatting, find-references, rename, document symbols/outline, workspace symbol
  search, `@namespace` template paths, and IntelliSense for JavaScript inside `<script>`.
