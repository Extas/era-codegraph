---
name: add-lang
description: Add or validate a tree-sitter language in CodeGraph end to end. Use when the user runs /add-lang or asks to support a new language, including grammar health, extraction, tests, real-repository benchmarks, documentation, and changelog updates.
---

# Add a CodeGraph language

Extend the current extraction pipeline and prove the result on real repositories. Read `CLAUDE.md` first; it owns current architecture, benchmark policy, release rules, and validation constraints.

## Hard constraints

- Never commit, push, publish, tag, or bump a version.
- Use the repository's existing scripts and closest extractor as the default; do not create a parallel framework.
- A grammar must pass the multi-grammar health check before extractor work begins.
- Do not ship partial coverage: extraction and representative end-to-end flows must pass before reporting success.
- The benchmark scripts own model and effort settings. Do not override them.
- Use three real repositories, one per size tier, and compare with/without CodeGraph with at least two runs per arm.

## Workflow

Copy and complete this checklist:

```text
- [ ] 1. Resolve the language and existing support
- [ ] 2. Select and health-check the grammar
- [ ] 3. Inspect the grammar AST
- [ ] 4. Wire detection, grammar, extractor, and registry
- [ ] 5. Build and repeat extraction verification until PASS
- [ ] 6. Add focused extraction tests
- [ ] 7. Curate three real repositories and questions
- [ ] 8. Run extraction probes and agent A/B benchmarks
- [ ] 9. Update README and CHANGELOG
- [ ] 10. Report evidence and remaining gaps
```

### 1. Resolve

Use the lowercase `Language` token used by `src/types.ts`. Check both `LANGUAGES` and `EXTRACTORS`. If support already exists, do not rewrite it; skip to real-repository validation.

### 2. Prove the grammar

Prefer an existing grammar from `tree-sitter-wasms`. Before editing code, run:

```bash
node scripts/add-lang/check-grammar.mjs <language> <valid-sample>
```

If it produces errors or corrupts a multi-grammar run, use a current ABI-compatible WASM build. Stop if no healthy grammar is available.

### 3. Inspect before mapping

Run `scripts/add-lang/dump-ast.mjs` on representative valid source covering functions, types, imports, calls, variables, and language-specific constructs. Map observed node and field names; do not infer them from another grammar.

### 4. Wire the existing owners

Update only the current owners required by the observed grammar:

- `src/types.ts`: language token and default include globs;
- `src/extraction/grammars.ts`: grammar file, extensions, display name, and vendored path when applicable;
- `src/extraction/languages/<language>.ts`: extractor definition;
- `src/extraction/languages/index.ts`: extractor registration;
- `src/extraction/tree-sitter.ts` only when generic extraction cannot reach a real nested construct.

Any vendored WASM belongs in `src/extraction/wasm/`; the existing build must copy it into the distribution.

### 5. Build and verify

Build, index a representative sample, then run `scripts/add-lang/verify-extraction.mjs`. On FAIL or thin extraction, inspect a richer AST, fix the mapping, rebuild, re-index, and repeat. Do not continue until verification passes.

### 6. Test observable extraction

Extend the existing extraction tests with language detection and representative symbols, imports, and calls. Run the focused test file first. Add framework resolution coverage only when the implementation adds that behavior.

### 7. Curate the corpus

Select three genuinely language-dominant public repositories: small, medium, and large. Give each a cross-file architecture or flow question. Record them in `.claude/skills/agent-eval/corpus.json` for reuse.

### 8. Benchmark retrieval value

Use the existing `scripts/add-lang/bench.sh` and `scripts/agent-eval/` harnesses. For every repository, record extraction health plus with/without duration, cost, tool calls, Read, Grep, and CodeGraph calls. Follow the current model policy and pass bars in `CLAUDE.md`.

### 9. Update user-facing docs

Update the supported-language inventory in `README.md`. Add one user-facing bullet under `CHANGELOG.md` → `## [Unreleased]` → `### New Features`; do not create a version block or use the retired Added/Changed/Fixed taxonomy.

### 10. Report

Report changed files, extraction evidence for all three repositories, A/B ranges, unresolved node or flow gaps, and the exact validation performed. Leave all changes for user review.