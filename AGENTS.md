# era-codegraph

Local fork of `@colbymchenry/codegraph` (tree-sitter → SQLite code graph, CLI + MCP) kept
for one purpose: indexing this workspace's repositories, including Era games through the
fork's own Era adapter (ERB + ontology CSV + engine profile — see `docs/era.md`; the
adapter is why this fork exists). Upstream publishing infrastructure, self-upgrade,
telemetry, its test suite, the Rust kernel experiment, and unused language grammars were
removed; git history has them. The agent-config installer remains because CLI + MCP setup
is a live local consumer.
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

2026-08-28: the installed `codegraph` command and Codex MCP config proved the local CLI,
MCP server, and agent-config installer are live consumers. Remote update checks,
self-upgrade, telemetry, and the beta signup were removed so the Era adapter cannot be
silently replaced by an upstream release. `npm run build` starts from a clean `dist/`;
the build, MCP handshake, agent-config printout, and self-index witness are green. The
verified build is deployed to the command on PATH; re-indexing the existing `eym` graph
produced 1,239 `erabasic` files, 283 `eracsv` files, and working dynamic call paths.
