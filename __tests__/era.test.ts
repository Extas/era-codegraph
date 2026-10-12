/**
 * Era (Emuera) adapter contract: one `it` per clause of the fork's Era contract.
 *
 * `fixtures/era-game` is a minimal game in the shape Emuera loads (UTF-8 BOM,
 * top-level ERB/ and CSV/), plus the decoys the contract keeps out: an optional
 * patch tree, a CSV the engine does not load as ontology, and a Rails `.erb`.
 * It is copied to a temp dir and indexed once, in-process. The >1 MB dialogue
 * script for the size cap is generated there, so no large file is committed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import type { Edge, Node } from '../src/types';

const FIXTURE = path.join(__dirname, 'fixtures', 'era-game');
const BIG = 'ERB/KOJO_BIG.ERB';

describe('Era (Emuera) contract', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-game-'));
    fs.cpSync(FIXTURE, dir, { recursive: true });
    // Hand-written dialogue crosses 1 MB because CJK costs three bytes a character.
    const line = 'PRINTL 「今天也辛苦了。明天也请多多指教。」\n';
    const lines = line.repeat(Math.ceil((1.5 * 1024 * 1024) / Buffer.byteLength(line)));
    fs.writeFileSync(path.join(dir, BIG), `﻿@KOJO_BIG\n${lines}RETURN 0\n`);
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const one = (nodes: Node[], what: string): Node => {
    expect(nodes, `exactly one ${what}`).toHaveLength(1);
    return nodes[0]!;
  };
  const fn = (name: string) =>
    one(cg.getNodesByName(name).filter((n) => n.kind === 'function'), `function @${name}`);
  const slot = () => one(cg.getNodesByQualifiedName('ERA::SLOT::ABL:10'), 'constant ERA::SLOT::ABL:10');
  const out = (from: Node, kind: string, to?: Node): Edge[] =>
    cg.getOutgoingEdges(from.id).filter((e) => e.kind === kind && (!to || e.target === to.id));
  const refName = (e: Edge) => String(e.metadata?.refName);

  it('recognises top-level ERB/ scripts, root CSV/ engine tables and Chara*.csv at any depth only', () => {
    const language = new Map(cg.getFiles().map((f) => [f.path, f.language as string]));
    const expected: Record<string, string | null> = {
      'ERB/COMABLE.ERB': 'erabasic',
      'ERB/TRAIN.ERB': 'erabasic',
      'CSV/GameBase.csv': 'eracsv',
      'CSV/Abl.csv': 'eracsv',
      'CSV/Chara/Chara001.csv': 'eracsv',
      'CSV/VariableSize.csv': null, // engine-read, but not an ontology table
      'patch/ERB/X.ERB': null, // ERB/ below the top level is never loaded
      'patch/CSV/Abl.csv': null, // nor is CSV/ outside the project root
    };
    expect(Object.fromEntries(Object.keys(expected).map((p) => [p, language.get(p) ?? null]))).toEqual(expected);
    // `<%` with no Era marker is a Rails template, even under ERB/.
    expect(language.get('ERB/view.html.erb')).not.toBe('erabasic');
  });

  it('resolves by-name and by-number access to one ERA::SLOT constant', () => {
    const abl10 = slot();
    expect(abl10).toMatchObject({ kind: 'constant', name: '顺从' });
    // @COM_ABLE100 reads ABL:顺从 and ABL:10; both land on this node.
    expect(out(fn('COM_ABLE100'), 'reads', abl10)).toHaveLength(2);
  });

  it('emits reads for reads and writes for assignments, from the accessing function to the slot', () => {
    const abl10 = slot();
    expect(out(fn('COM_ABLE100'), 'writes', abl10)).toHaveLength(0); // SIF ABL:… only reads
    expect(out(fn('EXEC_COM'), 'writes', abl10)).toHaveLength(1); // ABL:10 = 1
    expect(out(fn('EXEC_COM'), 'reads', abl10)).toHaveLength(0);
  });

  it('keeps each index form as its own edge, carrying the raw chain in metadata.refName', () => {
    const refs = (from: string, kind: string) => out(fn(from), kind, slot()).map(refName).sort();
    expect(refs('COM_ABLE100', 'reads')).toEqual([expect.stringMatching(/ABL:10$/), expect.stringMatching(/ABL:顺从$/)]);
    expect(refs('EXEC_COM', 'writes')).toEqual([expect.stringMatching(/ABL:10$/)]);
  });

  it('binds an unnamed slot to its built-in variable instead of dropping it', () => {
    const writes = out(fn('EXEC_COM'), 'writes').filter((e) => /TFLAG:899$/.test(refName(e)));
    expect(writes).toHaveLength(1);
    expect(cg.getNode(writes[0]!.target)?.name).toBe('TFLAG');
  });

  it('turns a Chara*.csv sheet into an ERA::CHARA module whose rows write the slots they initialise', () => {
    const sheet = one(cg.getNodesByQualifiedName('ERA::CHARA::1'), 'module ERA::CHARA::1');
    expect(sheet.kind).toBe('module');
    expect(out(sheet, 'writes', slot())).toHaveLength(1); // 能力,10,2
  });

  it('fans an interpolated call out to every matching function as heuristic era-dispatch calls', () => {
    const calls = out(fn('EXEC_COM'), 'calls').filter((e) => e.metadata?.synthesizedBy === 'era-dispatch');
    // TRYCALLFORM COM_ABLE{ARG}(TARGET): the argument list is stripped before
    // matching, and patch/ERB's @COM_ABLE102 is no candidate.
    expect(calls.map((e) => cg.getNode(e.target)?.name).sort()).toEqual(['COM_ABLE100', 'COM_ABLE101']);
    for (const e of calls) expect(e).toMatchObject({ provenance: 'heuristic', metadata: { candidates: 2 } });
  });

  it('records branches:N, random and dynamic-dispatch:N in function decorators', () => {
    // @EXEC_COM: IF + SIF, RAND:2, one TRYCALLFORM.
    expect(fn('EXEC_COM').decorators).toEqual(expect.arrayContaining(['branches:2', 'random', 'dynamic-dispatch:1']));
  });

  it('indexes a >1 MB script under ERB/ (16 MB cap) without reporting it as changed', () => {
    expect(fs.statSync(path.join(dir, BIG)).size).toBeGreaterThan(1024 * 1024);
    expect(fn('KOJO_BIG').filePath).toBe(BIG);
    expect(cg.getChangedFiles().modified).not.toContain(BIG);
  });
});
