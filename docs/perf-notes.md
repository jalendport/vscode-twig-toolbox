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
- **Catalogs.** The real shipped `twig-core.json` + `craft.json`, in a Craft 5 workspace context, so
  the Craft pack activates. A stub pack would measure the wrong thing.
- **Entry points.** The functions the server actually calls (`getMergedCompletions`,
  `createParsedDocument`) — not the narrower internals.
- **Sampling.** 10 warmup iterations discarded (JIT tiering is not the steady state), then 50 timed.

Recorded on Apple M-series (darwin/arm64), Node 26.3.0. Absolute numbers move with hardware; the
headroom is the point.

## Results

All four budgets pass, each by more than an order of magnitude.

| Budget                                           | Measured                         | Headroom |
| ------------------------------------------------ | -------------------------------- | -------- |
| Completion response p95 < 100 ms                 | **4.58 ms** p95 (3.02 ms median) | ~22×     |
| Parse of a 2,000-line template < 20 ms           | **4.01 ms** p95 (2.21 ms median) | ~5×      |
| Server memory < 150 MB on a 500-template project | **~108 MB** RSS worst case       | ~1.4×    |
| No event-loop stall > 250 ms during bulk edits   | **7.85 ms** worst of 120 edits   | ~32×     |

### Completion latency

Measured at eight cursor positions in a 2,000-line document, one per path a user actually hits:

| Probe              | Median  | p95     | Items |
| ------------------ | ------- | ------- | ----- |
| tag name `{% ‸ %}` | 2.81 ms | 3.78 ms | 47    |
| filter after pipe  | 3.00 ms | 3.89 ms | 132   |
| function name      | 2.97 ms | 3.86 ms | 120   |
| test after `is`    | 2.70 ms | 3.51 ms | 26    |
| `craft.*` member   | 2.77 ms | 3.56 ms | 12    |
| query chain member | 2.89 ms | 3.60 ms | 92    |
| HTML tag           | 3.94 ms | 5.16 ms | 116   |
| HTML attribute     | 3.77 ms | 5.19 ms | 152   |

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

### Event-loop stalls

The server parses on the main thread on a debounce timer, so one parse is exactly the span the
event loop cannot service anything else — measuring the parse the debounce runs _is_ measuring the
stall it causes. 120 consecutive mid-document edits to a 2,000-line template (worst case: every
later offset shifts) produced a worst stall of 7.85 ms, against a 250 ms budget.

## Decision: no optimization

Profiled first, per the milestone spec. The split at the completion budget:

```
parse (2,000 lines)          median 2.34 ms
completion on a warm parse   median 2.77 ms
catalog load (once/session)  1.65 ms
```

Nothing here justifies work. PLAN.md keeps incremental parsing as a contingency —
"full re-parse per change (debounced); perf budget in milestone 11, incremental parsing only if the
budget fails". **The budget does not fail**, by ~5× on the parse and ~22× on completion, so
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

- **Download.** The `.vsix` is **634 KB** — the bundle compresses well, and this is small by
  marketplace standards.
- **Startup.** The full bundle parses and evaluates in **65 ms**, once, when the server starts —
  which happens on first Twig file, not on VS Code launch (activation is `onLanguage:twig`).
- **Memory.** +34 MB, counted in the total above.

A one-time 65 ms and a 634 KB download are a fair price for working HTML/CSS IntelliSense inside
Twig, which was milestone 07's entire point.

### Fixed during the audit

`npm run package` called `npm run build`, which never passed `--production` — so the `.vsix` was
being built **unminified**, shipping a 3.17 MB `server.js`. `package` now runs `build:production`:

|                     | Before  | After             |
| ------------------- | ------- | ----------------- |
| `dist/server.js`    | 3.17 MB | 1.80 MB           |
| `dist/extension.js` | 950 KB  | 436 KB            |
| `.vsix`             | 776 KB  | **634 KB** (−18%) |

Sourcemaps were already excluded by `.vscodeignore`, so they were never shipped.

### Noted, not acted on

`beautify-html.js` and `beautify-css.js` (~85 KB combined) are formatters reached through the
language services' entry points and tree-shaking does not drop them. Formatting is a post-v1
non-goal, so this is dead weight — but at ~4.6% of the bundle it does not justify patching around
another package's module graph. Worth revisiting only if formatting stays out of scope _and_ the
bundle becomes a problem, which on the numbers above it is not.
