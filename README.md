# era-codegraph

Local fork of [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) kept to
index this workspace's repositories — including Era games through the fork's own Era
adapter (ERB + ontology CSV + engine profile, see [docs/era.md](docs/era.md)).
Current state, rules, and rationale live in [AGENTS.md](AGENTS.md).

## Use

```bash
npm run build
node dist/bin/codegraph.js init      # in the repository to index
node dist/bin/codegraph.js explore "<symbol or question>"
```

This machine's default Node (26.x) crashes tree-sitter WASM compilation; use scoop's
side-by-side LTS: `D:/ProgramData/scoop/apps/nodejs-lts/current/node.exe`.

## Verify

```bash
npm run witness
```
