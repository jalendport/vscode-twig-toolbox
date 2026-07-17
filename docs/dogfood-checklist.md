# Dogfood checklist

Milestone 11, deliverable 2. This is the one part of launch an agent cannot do: it needs real Craft
projects and a human's judgement about how the extension _feels_. The bar is not "it works" — the
milestone's bar is **"nothing feels worse than the [Antlers][antlers] or [Laravel][laravel]
extensions"**, which are the quality benchmarks named in PLAN.md.

Run it against **2–3 real Craft projects** (at least one of your own, ideally one large and one
small) plus **one plain-Twig project** with no Craft in it, over a week-equivalent of real editing —
not a scripted pass. Note anything that annoys you, however small; "slightly off" is the thing this
checklist exists to catch, because the measurable stuff already passes (see
[perf-notes.md](perf-notes.md)).

## How to run it

1. `npm run package` → install the `.vsix` (`code --install-extension twig-toolbox-*.vsix`).
2. Disable any other Twig extension first, or you will be reviewing someone else's highlighting.
3. Work normally. Come back and tick things off.

Record each item as pass / fail / note. Anything failing gets an issue before 1.0.0 ships.

## Typing latency

- [ ] Typing in a large template (1,000+ lines) never feels like it stutters or lags behind.
- [ ] Completions appear fast enough that you don't wait for them — they're just _there_.
- [ ] No pause when opening a large template for the first time.
- [ ] No pause when opening the first Twig file of a session (server start + catalog load).
- [ ] Editing with a big project open (500+ templates) feels the same as with one file open.
- [ ] Typing fast doesn't produce a backlog of stale suggestions.

## Completion relevance

- [ ] The item you want is in the **top few**, not buried — sort order is doing real work.
- [ ] `{% ` offers tags, and not filters or functions.
- [ ] `|` offers filters, and not tags.
- [ ] `is ` offers tests.
- [ ] `craft.` offers the Craft API and nothing irrelevant.
- [ ] Query chains (`craft.entries.section('news').`) keep offering the right members down the chain.
- [ ] Your project's **real** section / field / entry-type handles appear (the milestone 10 magic).
- [ ] Variables in scope (`{% set %}`, `{% for %}` loop vars, macro params) are offered.
- [ ] HTML tags and attributes complete inside markup.
- [ ] Emmet abbreviations expand (`ul>li*3` + Tab).
- [ ] No duplicate entries where Twig and HTML completions overlap.
- [ ] Craft entries do **not** appear in the plain-Twig project.
- [ ] Nothing from Craft 5 shows up in a Craft 4 project (and vice versa).

## No flicker

- [ ] Highlighting doesn't flash or re-colour while typing, especially mid-`{{ }}`.
- [ ] Incomplete constructs (`{{ foo|`, `{% if `) don't make the file "go plain" for a frame.
- [ ] Diagnostics don't appear-then-vanish while typing a valid construct.
- [ ] The completion popup doesn't close and reopen on its own.
- [ ] Auto-closing tags don't fight you or produce stray `</div>`.

## Diagnostics honesty

The policy from PLAN.md is **zero false positives out of the box**. This is the section to be
harshest in.

- [ ] Across all real projects, out of the box: **no false positives at all**. Not "few".
- [ ] Real syntax errors are actually reported (delete an `{% endif %}` and check).
- [ ] Error squiggles land on the right range — not the whole file, not one character off.
- [ ] Error messages say something a human can act on.
- [ ] A malformed file degrades gracefully: the rest still highlights and completes.
- [ ] With `twigToolbox.diagnostics.unknownNames` raised to `warning`, the reports are fair, and
      `twigToolbox.diagnostics.ignoredNames` silences the ones that aren't.

## Navigation

- [ ] Go-to-definition works on `{% extends %}` / `{% include %}` / `{% embed %}` paths.
- [ ] Template paths complete as you type them, including into subdirectories.
- [ ] Cmd/Ctrl-click on a template path opens it.
- [ ] Go-to-definition works on an imported macro.
- [ ] Roots resolve correctly without setting `twigToolbox.templateRoots` by hand.
- [ ] If a project needs `twigToolbox.templateRoots`, setting it works and is obvious.

## Hover

- [ ] Hovering a filter/function/tag gives useful docs, not a bare restatement of the name.
- [ ] Docs links go to the right upstream page.
- [ ] Craft items hover with Craft docs; Twig core items with Twig docs.
- [ ] Hover doesn't obscure what you're typing.

## Install and environment

- [ ] Installs clean into **stock VS Code** from the `.vsix`, no errors in the Output panel.
- [ ] Installs clean into **Cursor**.
- [ ] Works in a **multi-root** workspace (two Craft projects in one window; each gets its own
      catalogs and roots).
- [ ] Works over Remote-SSH / devcontainers, if you use them.
- [ ] `.html.twig` files get the same treatment as `.twig`.
- [ ] No errors in the "Twig Toolbox" output channel during a normal session.
- [ ] Extension does **not** activate in a window with no Twig file open.

## Against the benchmark

Open the same kind of file in [Antlers][antlers] (Statamic) or [Laravel][laravel] and compare
directly. Be honest.

- [ ] Completions feel as responsive.
- [ ] Completion lists feel as relevant.
- [ ] Hover docs are as rich.
- [ ] Highlighting is at least as good.
- [ ] Nothing about ours feels cheaper or noticeably worse.

## Sign-off

The milestone requires this to be signed off by a human before 1.0.0 ships.

- Projects used: _______________________________________________
- Period covered: ______________________________________________
- Issues filed: ________________________________________________
- Signed off by: _____________________ Date: __________________

[antlers]: https://github.com/Stillat/vscode-antlers-language-server
[laravel]: https://github.com/laravel/vs-code-extension
