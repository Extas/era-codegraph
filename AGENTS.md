# era-codegraph

Local fork of `@colbymchenry/codegraph` (tree-sitter → SQLite code graph, CLI + MCP) kept
for one purpose: indexing this workspace's repositories, including Era games through the
fork's own Era adapter (ERB + ontology CSV + engine profile — see `docs/era.md`; the
adapter is why this fork exists). Upstream publishing infrastructure, its test suite, the
Rust kernel experiment, and unused language grammars were removed; git history has them.
Facts ledger: `.project/ledger.jsonl` (append one JSON line per durable ruling).

## Working rules

- Vendored grammars in `src/extraction/wasm/` cover python, typescript/tsx, javascript,
  rust, c, cpp — the languages this workspace actually contains. Other languages degrade
  gracefully (grammar load failure skips the file with a warning); to add one back, restore
  its wasm from git history — the registry in `src/extraction/grammars.ts` still knows it.
- Era extraction is wasm-free (own extractors for ERB/CSV); the engine profile is built by
  `scripts/era/build-engine-profile.mjs` and read by extractor and resolver alike.
- `npm run build` compiles and copies assets into `dist/`; `npm run witness` is the only
  test: it builds an index of this repository's own `src/` and answers a query through the
  real CLI. Correctness beyond that is judged by using the tool on the workspace.
- Upstream sync is manual and opt-in: cherry-pick, then re-run the witness.

## Last Verified

2026-08-27: after the collapse review (site, telemetry worker, installers, CI, upstream
test suite and eval harness, Rust kernel with its four grammar trees, 22 unused vendored
wasms, and upstream docs removed; package scripts and dev-deps trimmed) `npm run build`
and the self-index witness are green.
