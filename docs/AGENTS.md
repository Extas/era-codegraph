# AGENTS.md (docs/)

Nested Codex guidance under `docs/`. Loaded with the repo-root `AGENTS.md` when cwd is under `docs/` (Codex walks root to cwd; shared `project_doc_max_bytes` budget).

Era maintenance uses direct semantic evidence: input decoding, slot identity,
incremental/fresh equivalence and actual CLI/MCP consumers. Run checks relevant
to the changed boundary when validation is authorized; no cross-repository
Agent A/B, model choice, navigation budget or full-suite prerequisite applies.

The historical benchmark methodology and raw results remain in `benchmarks/`
and the linked upstream playbooks below. They are optional research material,
not admission requirements for this fork.

Full playbook + per-mechanism design: `docs/design/dynamic-dispatch-coverage-playbook.md` and `docs/design/callback-edge-synthesis.md`.

### Worked example — Excalidraw (TS/React, medium, 643 files)

The template to replicate per language/framework. Question: *"how does updating an element re-render the canvas on screen?"* (the full flow crosses three React boundaries: observer callback, `setState`→`render`, and JSX child).

| Stage | duration | Read | Grep | codegraph |
|---|---|---|---|---|
| Without codegraph | 115–139s | 9–10 | 10–11 | 0 |
| Broken (explore-budget regression) | 131–139s | 5–10 | 3–5 | 6–14 |
| Fixed (budget + msgs + synthesis) | 64–112s | 0–2 | 2–4 | 3–**10** |
| + trace-first steering | **51–74s** | **0–2** | 0–4 | **3–4** |

n=4 unhooked runs/stage, same prompt. After steering flow questions to `codegraph_trace` first: **best run 0 Read / 0 Grep / 3 codegraph / 51s**; **2 of 4 fully clean** (0 Read, 0 Grep). Steering eliminated the over-drill variance — call count tightened from 3–10 to 3–4, trace adoption went 3/4 → 4/4, and the `search`+`callers` path-reconstruction floundering dropped to 0. Run-to-run variance is still real; report the range, never a single run. **Residual reads/greps are all the nonce data-flow** (`canvasNonce` — a local prop with no graph edges); that's the def-use/data-flow frontier, left deliberately uncovered (tracking every local would explode the graph). Validated: `trace(mutateElement, renderStaticScene)` connects in **6 hops** across all three boundaries (`mutateElement → triggerUpdate → [callback] triggerRender → [react-render] render → [jsx] StaticCanvas → renderStaticScene`), each hop showing inline source + the wiring site; node count stable at 9,289; 1 callback + 46 react-render + 280 jsx-render synthesized edges (no explosion, precision-checked).


Also see: `docs/design/dynamic-dispatch-coverage-playbook.md`, `docs/design/callback-edge-synthesis.md`, `docs/benchmarks/call-sequence-analysis.md`, `docs/benchmarks/agent-eval-feedback-metrics.md`.
