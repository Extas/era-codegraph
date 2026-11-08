/**
 * Era (Emuera) extraction and resolution behavior.
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
import { ToolHandler } from '../src/mcp/tools';
import { validateAnswerFiles } from '../src/mcp/answer-freshness';
import { extractEraCsv, getEraProfile } from '../src/era';
import { decodeSourceBytes, readSourceText } from '../src/file-limits';

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

  it('indexes a >1 MB script under ERB/ (16 MB cap)', () => {
    expect(fs.statSync(path.join(dir, BIG)).size).toBeGreaterThan(1024 * 1024);
    expect(fn('KOJO_BIG').filePath).toBe(BIG);
  });
});

describe('Era source facts across indexing lifetimes', () => {
  const roots: string[] = [];
  const graphs: CodeGraph[] = [];
  afterAll(() => {
    for (const graph of graphs) graph.close();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  function game(csv: string | Buffer, erb: string | Buffer): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'era-facts-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'CSV'));
    fs.mkdirSync(path.join(root, 'ERB'));
    fs.writeFileSync(path.join(root, 'CSV/GameBase.csv'), 'タイトル,fixture\n');
    fs.writeFileSync(path.join(root, 'CSV/Abl.csv'), csv);
    fs.writeFileSync(path.join(root, 'ERB/main.erb'), erb);
    return root;
  }
  async function index(root: string): Promise<CodeGraph> {
    const graph = await CodeGraph.init(root);
    graphs.push(graph);
    await graph.indexAll();
    return graph;
  }
  function bindings(graph: CodeGraph): Array<[string | undefined, string | undefined, number | undefined]> {
    const fn = graph.getNodesByName('PROBE').find(n => n.kind === 'function')!;
    return graph.getOutgoingEdges(fn.id).filter(e => e.kind === 'reads').map(e => {
      const target = graph.getNode(e.target);
      return [String(e.metadata?.refName), target?.qualifiedName, target?.startLine] as [string, string | undefined, number | undefined];
    }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }

  it('rebinds unchanged and edited ERB after CSV changes, isolated from another project and equal to fresh', async () => {
    const a = game('10,OLD\n', '@PROBE\nSIF ABL:OLD > 0\nRETURN 1\n');
    const b = game('20,OTHER\n', '@PROBE\nSIF ABL:OTHER > 0\nRETURN 1\n');
    const ga = await index(a);
    const gb = await index(b);
    const other = bindings(gb);
    fs.writeFileSync(path.join(a, 'CSV/Abl.csv'), '11,OLD\n12,NEW\n');
    await ga.sync();
    expect(bindings(ga)[0]?.[1]).toBe('ERA::SLOT::ABL:11');
    fs.writeFileSync(path.join(a, 'CSV/Abl.csv'), '13,NEW\n');
    fs.writeFileSync(path.join(a, 'ERB/main.erb'), '@PROBE\nSIF ABL:NEW > 0\nRETURN 2\n');
    await gb.sync();
    await ga.sync();
    expect(bindings(gb)).toEqual(other);
    const fresh = await index(game('13,NEW\n', '@PROBE\nSIF ABL:NEW > 0\nRETURN 2\n'));
    expect(bindings(ga)).toEqual(bindings(fresh));
  }, 120_000);

  it('uses final numeric rows, lowest final named slot and exact raw whitespace while retaining conflict evidence', async () => {
    const csv = '8,SAME\n3,SAME\n3,OLD\n3,SAME\n4, PAD \n5,OLD\n5,\n';
    const extracted = extractEraCsv('CSV/Abl.csv', csv);
    expect(extracted.errors.filter(e => e.code === 'era_duplicate_slot').map(e => e.line)).toEqual([3, 4, 7]);
    expect(extracted.nodes.filter(n => n.qualifiedName === 'ERA::SLOT::ABL:3').map(n => [n.name, n.startLine])).toEqual([['SAME', 2], ['OLD', 3], ['SAME', 4]]);
    const root = game(csv, '@PROBE\nSIF ABL:SAME > 0\nRETURN 1\nSIF ABL:3 > 0\nRETURN 2\nSIF ABL:OLD > 0\nRETURN 3\nSIF ABL:PAD > 0\nRETURN 4\n');
    fs.writeFileSync(path.join(root, 'CSV/Chara001.csv'), '番号,1\n能力, PAD ,1\n');
    const graph = await index(root);
    const targets = bindings(graph);
    expect(targets.filter(r => r[0]?.endsWith(':3') || r[0]?.endsWith(':SAME')).map(r => r.slice(1))).toEqual([['ERA::SLOT::ABL:3', 4], ['ERA::SLOT::ABL:3', 4]]);
    expect(targets.filter(r => r[0]?.endsWith(':OLD') || r[0]?.endsWith(':PAD')).map(r => r[1])).toEqual(['ERA::VAR::ABL', 'ERA::VAR::ABL']);
    const chara = graph.getNodesByQualifiedName('ERA::CHARA::1')[0]!;
    expect(graph.getOutgoingEdges(chara.id).filter(e => e.kind === 'writes').map(e => graph.getNode(e.target)?.name)).toEqual([' PAD ']);
    expect(graph.getNodesByQualifiedName('ERA::SLOT::ABL:5').find(n => n.startLine === 7)?.decorators).toContain('era:empty-slot-name');
  }, 120_000);

  it('indexes and displays equivalent UTF-8 and CP932 input with identical freshness hashes', async () => {
    const csv = '10,能力\n';
    const erb = '@試験\nSIF ABL:能力 > 0\nRETURN 1\n';
    const sjisCsv = Buffer.concat([Buffer.from('10,'), Buffer.from('945c97cd', 'hex'), Buffer.from('\n')]);
    const sjisErb = Buffer.concat([Buffer.from('@'), Buffer.from('8e8e8cb1', 'hex'), Buffer.from('\nSIF ABL:'), Buffer.from('945c97cd', 'hex'), Buffer.from(' > 0\nRETURN 1\n')]);
    const utf = await index(game(csv, erb));
    const sjisRoot = game(sjisCsv, sjisErb);
    const sjis = await index(sjisRoot);
    for (const graph of [utf, sjis]) {
      const fn = graph.getNodesByName('試験')[0]!;
      expect(graph.getOutgoingEdges(fn.id).filter(e => e.kind === 'reads').map(e => graph.getNode(e.target)?.name)).toEqual(['能力']);
      expect(await graph.getCode(fn.id)).toContain('ABL:能力');
      const handler = new ToolHandler(graph);
      const result = await handler.execute('codegraph_node', { file: 'ERB/main.erb' });
      expect(JSON.stringify(result)).toContain('ABL:能力');
    }
    expect(sjis.getFile('ERB/main.erb')?.contentHash).toBe(utf.getFile('ERB/main.erb')?.contentHash);
    expect(readSourceText(path.join(sjisRoot, 'ERB/main.erb'), 'ERB/main.erb')).toBe(erb);
    expect(await validateAnswerFiles(sjisRoot, [{ path: 'ERB/main.erb', contentHash: sjis.getFile('ERB/main.erb')!.contentHash }])).toEqual({ stale: [], unchecked: [] });
    expect(() => decodeSourceBytes(Buffer.from([0xef, 0xbb, 0xbf, 0xff]), 'ERB/main.erb')).toThrow();
    fs.writeFileSync(path.join(sjisRoot, 'ERB/main.erb'), Buffer.concat([sjisErb, Buffer.from(';changed\n')]));
    expect((await validateAnswerFiles(sjisRoot, [{ path: 'ERB/main.erb', contentHash: sjis.getFile('ERB/main.erb')!.contentHash }])).stale).toEqual(['ERB/main.erb']);
  }, 120_000);

  it('reloads an edited profile and reparses unchanged source in the same instance', async () => {
    const root = game('10,KNOWN\n', '@PROBE\nSIF ABL:KNOWN > 0\nRETURN 1\n');
    const profilePath = path.join(root, 'engine.json');
    const profile = structuredClone(getEraProfile().profile);
    fs.writeFileSync(profilePath, JSON.stringify(profile));
    const prior = process.env.CODEGRAPH_ERA_PROFILE;
    process.env.CODEGRAPH_ERA_PROFILE = profilePath;
    try {
      const graph = await index(root);
      profile.variables = profile.variables.filter(v => v.name !== 'ABL');
      fs.writeFileSync(profilePath, JSON.stringify(profile));
      await graph.sync();
      expect(graph.getNodesByQualifiedName('ERA::VAR::ABL')).toEqual([]);
      expect(bindings(graph)).toEqual([]);
      const fresh = await index(game('10,KNOWN\n', '@PROBE\nSIF ABL:KNOWN > 0\nRETURN 1\n'));
      expect(bindings(graph)).toEqual(bindings(fresh));
    } finally {
      if (prior === undefined) delete process.env.CODEGRAPH_ERA_PROFILE;
      else process.env.CODEGRAPH_ERA_PROFILE = prior;
    }
  }, 120_000);

  it('keeps a 17 MB ERB outside decoding, indexing and source display', async () => {
    const root = game('10,KNOWN\n', '@PROBE\nRETURN 1\n');
    const file = path.join(root, 'ERB/oversize.erb');
    const fd = fs.openSync(file, 'w');
    try { fs.ftruncateSync(fd, 17 * 1024 * 1024); } finally { fs.closeSync(fd); }
    expect(readSourceText(file, 'ERB/oversize.erb')).toBeNull();
    const graph = await index(root);
    expect(graph.getFile('ERB/oversize.erb')?.nodeCount).toBe(0);
    expect(graph.getFile('ERB/oversize.erb')?.errors?.some(e => e.code === 'size_exceeded')).toBe(true);
    const result = await new ToolHandler(graph).execute('codegraph_node', { file: 'ERB/oversize.erb' });
    expect(JSON.stringify(result)).toMatch(/could not read|too large|limit/i);
  }, 120_000);
});
