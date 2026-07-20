# Performance notes

Milestone 11's performance pass: what was measured, what it cost, and what was decided.

Reproduce with `npm run bench`. The same measurements run as budget assertions in
`tests/perf/perf.test.ts`, so `npm test` fails if a budget is ever breached.

## Method

- **Fixture.** A seeded generator (`tests/perf/fixture.ts`) builds a synthetic Craft project of
  500 templates plus the layout, macro and partial they reference. Template shapes are lifted from
  `tests/grammar/fixtures/real-world.twig` — nested `{% block %}`/`{% for %}`/`{% if %}`, filter
  chains, `craft.entries…` query chains, `{% cache %}`, embedded `<style>` and HTML. Generated
  rather than committed: 500 files of checked-in noise is repo weight nobody reads, and the seed
  makes runs comparable.
- **Catalogs.** The real shipped `twig-core.json` + `craft.json` + `craft-classes.json`, in a Craft 5
  workspace context, so the Craft pack activates. A stub pack would measure the wrong thing.
- **Entry points.** The functions the server actually calls (`getMergedCompletions`,
  `createParsedDocument`) — not the narrower internals.
- **Sampling.** 10 warmup iterations discarded (JIT tiering is not the steady state), then 50 timed.

Recorded on Apple M-series (darwin/arm64), Node 26.3.0. Absolute numbers move with hardware; the
headroom is the point.

## Results

Every budget passes, most by more than an order of magnitude.

| Budget                                           | Measured                         | Headroom |
| ------------------------------------------------ | -------------------------------- | -------- |
| Completion response p95 < 100 ms                 | **5.34 ms** p95 (3.47 ms median) | ~19×     |
| Parse of a 2,000-line template < 20 ms           | **4.48 ms** p95 (2.17 ms median) | ~4×      |
| Server memory < 150 MB on a 500-template project | **~108 MB** RSS worst case       | ~1.4×    |
| No event-loop stall > 250 ms during bulk edits   | **9.58 ms** worst of 120 edits   | ~26×     |
| Catalog startup < 50 ms, < 10 MB                 | **1.97 ms**, 0.5 MB              | ~25×     |
| First member lookup < 150 ms, < 25 MB            | **8.97 ms**, 2.8 MB              | ~17×     |
| Later member lookups < 5 ms                      | **~0.005 ms** (cached)           | ~1000×   |

### Completion latency

Measured at eight cursor positions in a 2,000-line document, one per path a user actually hits:

| Probe              | Median  | p95     | Items |
| ------------------ | ------- | ------- | ----- |
| tag name `{% ‸ %}` | 2.95 ms | 4.31 ms | 47    |
| filter after pipe  | 3.44 ms | 5.20 ms | 132   |
| function name      | 2.94 ms | 4.37 ms | 119   |
| test after `is`    | 2.88 ms | 4.52 ms | 26    |
| `craft.*` member   | 2.93 ms | 5.07 ms | 12    |
| query chain member | 3.03 ms | 6.46 ms | 92    |
| HTML tag           | 3.96 ms | 5.68 ms | 116   |
| HTML attribute     | 3.78 ms | 5.66 ms | 152   |

The member probes carry the class model: `query chain member` is the one that reads
`craft-classes.json`, flattens ten element types, and still answers inside 6.5 ms.

The item counts are load-bearing, not decoration. The first version of this harness called
`getCompletions` rather than the `getMergedCompletions` the server actually calls, and so returned
**zero** items for both HTML probes — reporting a flattering 0.18 ms for work that never happened.
`perf.test.ts` now asserts every probe returns items, which is the assertion that would have caught
it.

Timing starts after the parse, because that is the real sequence: the document is parsed on a
debounce, and the completion request arrives against an already-parsed document.

### Memory

The budget is about the server process, so it is worth splitting:

| Component                                         | Cost                          |
| ------------------------------------------------- | ----------------------------- |
| Node baseline                                     | 46 MB                         |
| Server bundle loaded and evaluated                | +34 MB (80 MB RSS after load) |
| 500 templates parsed and **all retained at once** | +28 MB heap                   |
| **Total worst case**                              | **~108 MB**                   |

`npm run bench` reports the harness's own RSS baseline at ~300 MB — that is `tsx` holding the
TypeScript compiler, which the shipped server (one esbuild bundle) never loads. Only the deltas
transfer, which is why the report prints deltas.

Retaining all 500 parses simultaneously is deliberately pessimistic: it is the ceiling a
project-wide feature could reach, not the steady state of an editing session.

### Catalog load, and why the class model is a separate file

The Craft class model — the element classes, `craft.app`'s services, and everything they return — is
the largest thing shipped: **1.2 MB** of JSON against `craft.json`'s 421 KB. It is also the thing
nothing needs until someone types a `.`, so it is `catalogs/craft-classes.json` rather than part of
the pack, and `CatalogRegistry` opens it on the first member lookup and never before.

| Phase                 | Reads                           | Time      | Heap   |
| --------------------- | ------------------------------- | --------- | ------ |
| Startup (eager packs) | `twig-core.json` + `craft.json` | 1.97 ms   | 0.5 MB |
| First member lookup   | `craft-classes.json` + flatten  | 8.97 ms   | 2.8 MB |
| Every lookup after    | nothing — flatten cache         | ~0.005 ms | —      |

A plain Twig project never activates the Craft pack, so it never opens either Craft file: the loader
is keyed by pack name, which lets the registry decide it does not need the class model without
reading it to find out.

The file is 1.2 MB because of what it does **not** store, and both halves are load-bearing:

- **Inheritance factoring.** Members live on the class that declares them; a subclass names its
  parent and inherits at load time. `craft\base\Element` has ~250 members and eight element types
  extend it — flattening those into each is what made a naive version of this model cost 1.6 MB for
  a fraction of the surface, and it is why the model was cut the first time round.
- **Derived documentation links.** No member stores a `docsUrl`. The class reference's URL is a pure
  function of the declaring class, the member kind and the name, so it is computed at lookup — which
  saves ~40 bytes × 3,203 members and, more usefully, lets a Craft 4 project get Craft 4's page
  instead of whichever major the pack happened to be generated from.

Descriptions are capped at their first sentence for the same reason: a docblock summary runs to a
paragraph, and the sentence is the part that answers "what is this". The rest is what the link is
for.

### Event-loop stalls

The server parses on the main thread on a debounce timer, so one parse is exactly the span the
event loop cannot service anything else — measuring the parse the debounce runs _is_ measuring the
stall it causes. 120 consecutive mid-document edits to a 2,000-line template (worst case: every
later offset shifts) produced a worst stall of 9.58 ms, against a 250 ms budget.

## Decision: no optimization

Profiled first, per the milestone spec. The split at the completion budget:

```
parse (2,000 lines)          median 2.17 ms
completion on a warm parse   median 3.47 ms
catalog load (once/session)  1.97 ms
first member lookup          8.97 ms (once/session, and only if you dot into something)
```

Nothing here justifies work. PLAN.md keeps incremental parsing as a contingency —
"full re-parse per change (debounced); perf budget in milestone 11, incremental parsing only if the
budget fails". **The budget does not fail**, by ~4× on the parse and ~19× on completion, so
incremental parsing stays unbuilt. It would be a large, bug-prone complication bought with headroom
already in hand.

## Bundle size

Flagged in milestone 07: the bundled server grew to ~1.7 MB minified. It is now 1.8 MB. Composition
(esbuild metafile, minified bytes):

| Module                                               | Size   | Share |
| ---------------------------------------------------- | ------ | ----- |
| `vscode-css-languageservice`                         | 953 KB | 51.8% |
| `vscode-html-languageservice`                        | 466 KB | 25.3% |
| `yaml` (Craft project-config introspection)          | 112 KB | 6.1%  |
| our language server                                  | 72 KB  | 3.9%  |
| `vscode-languageserver` + jsonrpc + protocol + types | 187 KB | 10.2% |
| our parser                                           | 33 KB  | 1.8%  |

Drilling in, **57% of the whole bundle is two files**: `webCustomData.js` from the CSS service
(728 KB) and from the HTML service (317 KB). That is MDN's property/element/attribute database —
it _is_ the HTML and CSS feature. Dropping it means dropping milestone 07; there is no version of
"trim the data" that keeps the completions and hover docs it powers.

**Verdict: acceptable.** What the size actually costs:

- **Download.** The `.vsix` is **739 KB**, measured from a real `npm run package` run — the bundle
  and the catalogs both compress well, and this is small by marketplace standards.
- **Startup.** The full bundle parses and evaluates in **65 ms**, once, when the server starts —
  which happens on first Twig file, not on VS Code launch (activation is `onLanguage:twig`).
- **Memory.** +34 MB, counted in the total above.

A one-time 65 ms and a 754 KB download are a fair price for working HTML/CSS IntelliSense inside
Twig, which was milestone 07's entire point.

Modelling Craft's element and content classes moved the `.vsix` from 687 KB to **754 KB** (+67 KB,
+9.7%) — 712 KB of new JSON compressing down to that. It buys the whole template-facing content
surface: 100 classes, 3,203 members, and chains like `currentUser.photo.getDataUrl` that previously
dead-ended at `photo`.

### Fixed during the audit

`npm run package` called `npm run build`, which never passed `--production` — so the `.vsix` was
being built **unminified**, shipping a 3.17 MB `server.js`. `package` now runs `build:production`:

|                     | Before  | After             |
| ------------------- | ------- | ----------------- |
| `dist/server.js`    | 3.17 MB | 1.80 MB           |
| `dist/extension.js` | 950 KB  | 436 KB            |
| `.vsix`             | 776 KB  | **634 KB** (−18%) |

Sourcemaps were already excluded by `.vscodeignore`, so they were never shipped.

The 634 KB figure is this fix in isolation, from before the class model and later catalog work
changed the `.vsix`'s composition — see the measured **739 KB** current total above, not this table,
for what actually ships today.

### Noted, not acted on

`beautify-html.js` and `beautify-css.js` (~85 KB combined) are formatters reached through the
language services' entry points and tree-shaking does not drop them. Formatting is a post-v1
non-goal, so this is dead weight — but at ~4.6% of the bundle it does not justify patching around
another package's module graph. Worth revisiting only if formatting stays out of scope _and_ the
bundle becomes a problem, which on the numbers above it is not.
