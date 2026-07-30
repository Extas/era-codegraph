# Era (Emuera) adapter

Turns an Era game into a queryable graph: EraBasic scripts, the ontology CSVs
that name their state, and the engine that decides what both mean.

## Why it is not just another extractor

An Era game splits meaning across three layers, and no single one is readable
alone:

- **ERB** scripts say `SIF ABL:顺从 < 1`, but nothing in the script says what
  `ABL` is or what `顺从` names.
- **CSV** tables say row 10 of `Abl.csv` is `顺从`, but nothing says which
  variable that table names.
- **The Emuera engine** decides both: which CSV names which built-in variable,
  and which instructions dispatch to a target assembled at run time.

The engine layer is therefore not optional context, it is the binding. It is
extracted once into a JSON **engine profile** that the CSV extractor, the ERB
extractor, and the resolver all read, so the same decision is never restated in
three places and a game on a different Emuera build only needs a new profile.

## What it answers

Questions that no text search can answer on this source:

| Question | Why grep fails |
|---|---|
| What reaches `@COM_ABLE103`? | It is only ever called as `TRYCALLFORM COM_ABLE{com_id}`; the two ends share no literal. |
| Who else writes `TEQUIP:羞耻play`? | Writes and reads look identical in text, and the slot is referenced by name in some places and by number in others. |
| What does this behaviour read? | The answer spans a script, five CSVs, and a set of built-ins no file declares. |

## Layout

```
src/extraction/era/
  types.ts             engine profile shape
  profile.ts           profile loading; which files count as Era ontology
  lines.ts             comment/BOM handling shared by both extractors
  names.ts             the ERA:: qualified-name scheme
  csv-extractor.ts     ontology CSV rows -> named slot nodes
  erb-extractor.ts     .ERB/.ERH -> functions, declarations, reads/writes/calls
  engine-extractor.ts  CSV/GameBase.csv -> the built-in variable vocabulary
  profiles/*.json      generated engine profiles (checked in)
src/resolution/
  frameworks/era.ts    binds a variable access to the CSV row that names it
  era-dispatch.ts      fans an interpolated call site out to its candidates
scripts/era/
  build-engine-profile.mjs   generates a profile from a decompiled engine
```

## Generating a profile for another game

A profile is derived from the engine the game actually ships, not from a general
idea of Emuera. Modern Emuera builds are .NET single-file bundles, so the
executable has to be unpacked before it can be decompiled:

```bash
dotnet tool install -g sfextract
dotnet tool install -g ilspycmd

sfextract <game>/Emuera.exe -o /tmp/bundle          # -> Emuera.dll
ilspycmd -p -o /tmp/emuera-src /tmp/bundle/Emuera.dll

node scripts/era/build-engine-profile.mjs \
  --src /tmp/emuera-src \
  --engine <game>/Emuera.exe \
  --out src/extraction/era/profiles/<id>.json \
  --id <id>
```

The decompiled source is copyrighted engine code and is not checked in. The
generated profile is a table of names and flags, which is what a provenance
claim needs to be reviewable.

Select a profile with `CODEGRAPH_ERA_PROFILE=<id>` (or an absolute path to a
JSON file). The default is `emuera-1824-ee55`.

## Indexing a read-only source tree

A pinned source snapshot must stay byte-for-byte what its hash says it is, so
the index has to live outside it:

```bash
CODEGRAPH_INDEX_ROOT=/some/scratch/dir codegraph init /path/to/game
```

Every index for that root then lives under `<CODEGRAPH_INDEX_ROOT>/<name>-<hash>`
and the game directory is never written to.

## What is indexed, and what is not

- `.ERB`/`.ERH` are claimed only under the project's TOP-LEVEL `ERB/`, the one
  directory the engine reads. Games ship optional patches and dialogue templates
  containing their own `ERB/` trees; indexing those invents a second definition
  of functions the game defines once and offers unreachable dispatch candidates.
  Content is checked too, since Rails owns the same extension.
- `.csv` is never claimed globally. Only the ~29 files the engine actually loads
  (plus `GameBase.csv`), and only as `CSV/<name>` at the project root. A game may
  ship `Juel.csv` beside the rest, but the engine names JUEL through
  `Palam.csv`, so it is correctly left out.
- `CSV/chara/` is per-character instance data, not ontology, and is not indexed.
- The 1 MB file-size cutoff is raised to 16 MB for EraBasic: dialogue scripts are
  hand-written source that crosses 1 MB only because CJK costs three bytes a
  character.

## Per-access precision

A `reads`/`writes` edge carries the original index chain in
`metadata.refName`, so an access to a slot the game never named is still
addressable:

```sql
SELECT s.name, e.line FROM edges e JOIN nodes s ON s.id = e.source
WHERE e.kind = 'writes' AND json_extract(e.metadata, '$.refName') = 'ERA::REF::TFLAG:409'
```

The chain also separates different index forms on the same variable:
`ITEMPRICE:LOCAL`, `ITEMPRICE:COUNT` and `ITEMPRICE:(600 + COUNT)` are three
distinct edges, each with its own line.

## Reading the output

Variable and slot references resolve to `constant` nodes qualified
`ERA::SLOT::<VAR>:<index>`, so a reference by name and one by number land on the
same symbol. A slot the game never named (an index with no CSV row) binds to the
built-in variable instead of being dropped: an unnamed slot is a real answer and
belongs in that variable's consumers.

Interpolated call sites produce `calls` edges marked `provenance: heuristic`
with `metadata.synthesizedBy = "era-dispatch"` and a candidate count. They are
reach, not a direct call, and the output says so.

Function nodes carry traits in `decorators`: `branches:N`, `random`, and
`dynamic-dispatch:N`.
