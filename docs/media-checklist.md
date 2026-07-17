# Media checklist

The README's feature tour has five image slots, marked in the source with
`<!-- MEDIA: … -->` comments next to a placeholder link. Every one needs a real GIF before 1.0.0 —
they cannot be recorded headless, so this file specifies exactly what each must show.

Marketplace listings resolve relative image paths against the repository, so images must be
committed to `images/` and referenced relatively. `vsce package` rewrites them using the
`repository` field; nothing extra to configure.

## Recording setup

Use the same setup for all five, so the tour looks like one product rather than five screencasts.

| Setting | Value                                                                        |
| ------- | ---------------------------------------------------------------------------- |
| Theme   | Dark+ (default dark) — the safe default on both marketplace listings         |
| Font    | Editor default, size **16** — readable when the listing scales images down   |
| Window  | ~900×560, editor only: no sidebar, no panel, no minimap, no breadcrumbs      |
| Zen-ish | Hide the activity bar and status bar if they're not part of the point        |
| Format  | GIF, ≤ 15 fps, ≤ **2 MB** each (they land in the `.vsix`; see below)         |
| Length  | 4–8 seconds, looping cleanly, no dead frames at either end                   |
| Typing  | Deliberate, human pace. Real code from a real Craft project — no `foo`/`bar` |
| Cursor  | Make sure the completion popup is fully visible and not clipped              |

Trim ruthlessly: the viewer decides in about two seconds. Show the payoff immediately, don't build
up to it.

> **Size note.** `.vscodeignore` currently allow-lists only `images/icon.png`, so the GIFs will
> **not** ship in the `.vsix` — the marketplace fetches them from the repo. Keep it that way: five
> 2 MB GIFs would quadruple the 634 KB download for no benefit to installed users. If you ever do
> want them packaged, add them to `.vscodeignore` deliberately and re-check the size audit in
> [perf-notes.md](perf-notes.md).

## The five

### 1. `images/demo-highlighting.gif` — Syntax highlighting

**Slot:** README "Syntax highlighting" section.

Scroll slowly through a real, dense template — ideally the kind of thing in
`tests/grammar/fixtures/real-world.twig`. Must show, on screen, at once:

- `{% block %}` / `{% for %}` / `{% if %}` nesting
- a filter chain (`|date('F j, Y')`, `|striptags|trim`)
- a `{{ }}` interpolation inside an HTML attribute
- a `{% cache %}` tag with `using key "…#{entry.id}…"` string interpolation
- a `{# comment #}`
- an embedded `<style>` block

The point is _density_: everything is coloured correctly and distinctly, including the hard cases
(Twig inside attributes, interpolation inside strings). No typing — just a calm scroll.

### 2. `images/demo-completions.gif` — Context-aware completions

**Slot:** README "Completions" section.

Show that context decides the list, which is the whole claim. In one take:

1. Type `{% ` → tags appear (no filters).
2. Escape. Type `{{ entry.title|` → **filters** appear (no tags).
3. Escape. Type `{{ entry is ` → **tests** appear.

Let each popup sit for a beat before moving on. The viewer must register that the three lists are
_different_.

### 3. `images/demo-hover.gif` — Hover and signature help

**Slot:** README "Hover and signature help" section.

Two beats:

1. Hover a filter with real documentation — `date` or `default` — showing the signature, the
   parameter docs and the docs link.
2. Then type `|date(` and let signature help appear, showing the active parameter highlighted.

Pick a filter whose hover card is genuinely informative; a thin one undersells it.

### 4. `images/demo-navigation.gif` — Go to template

**Slot:** README "Template navigation" section.

1. In `{% include '` start typing → path completion offers real templates from the project, and
   descends into a subdirectory (`_partials/`).
2. Complete the path.
3. Cmd/Ctrl-click it (show the underline on hover) → the file opens.

The beat that matters is the click landing in the right file. Make the filename visible in the tab.

### 5. `images/demo-craft.gif` — Craft schema awareness

**Slot:** README "CraftCMS awareness" section. **This is the money shot** — milestone 10's magic,
and the thing no other Twig extension does. Give it the most care.

Record in a **real Craft project** whose `config/project/` has recognisable handles.

1. Type `craft.entries.section('` → the popup lists the project's **real section handles**.
2. Pick one, continue the chain: `.` → query methods appear.
3. Then `entry.` → the project's **real custom field handles** appear.

The viewer must understand these are _their own_ handles, not a canned list. If a handle is visibly
project-specific (`heroImage`, `pressReleases`), that reads instantly. Consider a one-frame glimpse
of the `config/project/` YAML at the start to make the source of the knowledge obvious — optional,
only if it doesn't pad the length.

## Before committing

- [ ] All five recorded at the same size and theme.
- [ ] Each ≤ 2 MB, ≤ 8 seconds.
- [ ] Text legible at the width the marketplace renders (~800 px).
- [ ] No personal or client-identifying content: no client names, no real URLs, no `.env`, nothing
      in a tab title or path that shouldn't be public.
- [ ] Placeholder links in `README.md` replaced, and the `<!-- MEDIA: … -->` comments removed.
- [ ] README preview checked on GitHub **and** via `vsce package` → the listing preview, since the
      marketplace resolves relative paths differently from GitHub.
