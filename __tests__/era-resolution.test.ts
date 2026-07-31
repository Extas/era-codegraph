/**
 * End-to-end Era resolution over a real index.
 *
 * The three layers only pay off together, so these tests index an actual (tiny)
 * game and ask the questions a remake asks: which rows does this behaviour
 * read, which does it write, and what reaches it. Each is a question that has
 * no answer from any single layer alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

interface EdgeRow {
  kind: string;
  source: string;
  target: string;
  targetQn: string;
  provenance: string | null;
  synthesizedBy: string | null;
}

function writeGame(dir: string): void {
  const csv = path.join(dir, 'CSV');
  const erb = path.join(dir, 'ERB');
  fs.mkdirSync(csv, { recursive: true });
  fs.mkdirSync(erb, { recursive: true });

  fs.writeFileSync(path.join(csv, 'GameBase.csv'), 'コード,1000\r\nタイトル,mini-era\r\n');
  fs.writeFileSync(path.join(csv, 'Base.csv'), '0,体力\r\n1,气力\r\n');
  fs.writeFileSync(path.join(csv, 'Talent.csv'), '10,胆怯\r\n120,男性\r\n');
  fs.writeFileSync(path.join(csv, 'Abl.csv'), ';能力\r\n0,Ｃ感觉\r\n10,顺从\r\n11,侍奉精神\r\n');
  fs.mkdirSync(path.join(csv, 'chara'), { recursive: true });
  fs.writeFileSync(
    path.join(csv, 'chara', 'Chara1002 テスト.csv'),
    ['番号,1002', '名前,テスト', '素質,10,1', '能力,顺从,5', '基礎,0,2000'].join('\r\n')
  );
  fs.writeFileSync(path.join(csv, 'Item.csv'), '40,大镜子,70,;羞耻play用\r\n49,浴室用大镜子,80000,\r\n');
  fs.writeFileSync(path.join(csv, 'Tequip.csv'), '43,羞耻play\r\n44,浴室play\r\n');
  fs.writeFileSync(path.join(csv, 'Flag.csv'), '15,指令扩展位\r\n');
  fs.writeFileSync(path.join(csv, 'Train.csv'), '103,羞耻play\r\n104,言语羞耻\r\n');
  fs.writeFileSync(path.join(csv, 'Palam.csv'), '0,恭順\r\n5,屈服\r\n');
  // Deliberately absent: Tflag.csv. TFLAG accesses must still resolve, to the
  // engine-declared variable, which is what an unnamed slot really is.

  fs.writeFileSync(
    path.join(erb, 'COM103.ERB'),
    [
      ';羞耻play 的执行判定',
      '@COM_ABLE103',
      'SIF (FLAG:15 & 512) == 0',
      '\tRETURN 0',
      ';已经在进行中则随时可以解除',
      'SIF TEQUIP:羞耻play',
      '\tRETURN 1',
      'SIF TEQUIP:浴室play == 0 && ITEM:大镜子 == 0',
      '\tRETURN 0',
      'SIF ABL:顺从 < 1',
      '\tRETURN 0',
      'SIF TFLAG:899 > 0',
      '\tRETURN 0',
      'RETURN COM_ABLE_BATTLE(103)',
      '',
      '@COM103',
      'TEQUIP:羞耻play = 1',
      'PALAM:TARGET:屈服 += 10',
      '',
      '@COM_ABLE104',
      'RETURN 1',
      '',
      ';不是指令，是普通助手，前缀相同但后缀不是数字',
      '@COM_ABLE_BATTLE(ARG)',
      'RETURN 1',
    ].join('\r\n')
  );

  fs.writeFileSync(
    path.join(erb, 'TRAIN.ERB'),
    ['@TRAIN_LOOP', '#DIM com_id', 'com_id = SELECTCOM', 'TRYCALLFORM COM_ABLE{com_id}'].join('\r\n')
  );
}

function readEdges(cg: CodeGraph, sourceName: string): EdgeRow[] {
  const db = (cg as unknown as { db: { db: any } }).db.db;
  return db
    .prepare(
      `SELECT e.kind kind, s.name source, t.name target, t.qualified_name targetQn,
              e.provenance provenance,
              json_extract(e.metadata,'$.synthesizedBy') synthesizedBy
       FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       WHERE s.name = ?`
    )
    .all(sourceName) as EdgeRow[];
}

describe('era cross-layer resolution', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-graph-'));
    writeGame(dir);
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
  });
  afterEach(() => {
    cg.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('binds a named index to the CSV row that defines it', () => {
    const edges = readEdges(cg, 'COM_ABLE103');
    const reads = edges.filter((e) => e.kind === 'reads');
    // `ABL:顺从` is meaningless until Abl.csv says 顺从 is row 10, and only the
    // engine says ABL is named through Abl.csv at all.
    expect(reads.map((e) => e.targetQn)).toContain('ERA::SLOT::ABL:10');
    expect(reads.map((e) => e.targetQn)).toContain('ERA::SLOT::ITEM:40');
    expect(reads.map((e) => e.targetQn)).toContain('ERA::SLOT::TEQUIP:44');
  });

  it('binds a numeric index to the same row a name would reach', () => {
    const reads = readEdges(cg, 'COM_ABLE103').filter((e) => e.kind === 'reads');
    expect(reads.map((e) => e.targetQn)).toContain('ERA::SLOT::FLAG:15');
  });

  it('binds an unnamed slot to the engine-declared variable instead of dropping it', () => {
    // The game ships no Tflag.csv, so TFLAG:899 has no name. Reporting the
    // access against the variable keeps it in that variable's consumers, which
    // is what an evidence gap looks like when it is honest about itself.
    const reads = readEdges(cg, 'COM_ABLE103').filter((e) => e.kind === 'reads');
    expect(reads.map((e) => e.targetQn)).toContain('ERA::VAR::TFLAG');
  });

  it('keeps write direction distinct from read direction', () => {
    const edges = readEdges(cg, 'COM103');
    const writes = edges.filter((e) => e.kind === 'writes').map((e) => e.targetQn);
    expect(writes).toContain('ERA::SLOT::TEQUIP:43');
    expect(writes).toContain('ERA::SLOT::PALAM:5');
    // A compound assignment reads its target too.
    expect(edges.filter((e) => e.kind === 'reads').map((e) => e.targetQn)).toContain('ERA::SLOT::PALAM:5');
    // The availability check only ever reads; nothing there is a write.
    expect(readEdges(cg, 'COM_ABLE103').filter((e) => e.kind === 'writes')).toHaveLength(0);
  });

  it('resolves a static call and reaches interpolated targets', () => {
    const calls = readEdges(cg, 'COM_ABLE103').filter((e) => e.kind === 'calls');
    expect(calls.map((e) => e.target)).toContain('COM_ABLE_BATTLE');

    const dispatch = readEdges(cg, 'TRAIN_LOOP').filter((e) => e.synthesizedBy === 'era-dispatch');
    const targets = dispatch.map((e) => e.target).sort();
    // `TRYCALLFORM COM_ABLE{com_id}` reaches every numbered command...
    expect(targets).toEqual(['COM_ABLE103', 'COM_ABLE104']);
    // ...and not the same-prefixed helper, which is the precision that makes
    // the fan-out usable as evidence rather than noise.
    expect(targets).not.toContain('COM_ABLE_BATTLE');
    // Synthesized reach is never presented as a direct call.
    expect(dispatch.every((e) => e.provenance === 'heuristic')).toBe(true);
  });

  it('answers the reverse question: what reaches this behaviour', () => {
    const db = (cg as unknown as { db: { db: any } }).db.db;
    const callers = db
      .prepare(
        `SELECT s.name FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE t.qualified_name = 'ERA::FN::COM_ABLE103' AND e.kind = 'calls'`
      )
      .all()
      .map((r: { name: string }) => r.name);
    expect(callers).toContain('TRAIN_LOOP');
  });

  it('answers who else touches a slot', () => {
    const db = (cg as unknown as { db: { db: any } }).db.db;
    const rows = db
      .prepare(
        `SELECT s.name name, e.kind kind FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE t.qualified_name = 'ERA::SLOT::TEQUIP:43' AND e.kind IN ('reads','writes')`
      )
      .all() as Array<{ name: string; kind: string }>;
    expect(rows).toEqual(
      expect.arrayContaining([
        { name: 'COM_ABLE103', kind: 'reads' },
        { name: 'COM103', kind: 'writes' },
      ])
    );
  });

  it('reaches a command added later, without duplicating existing edges', async () => {
    const db = (cg as unknown as { db: { db: any } }).db.db;
    const countDispatch = () =>
      (db
        .prepare(
          `SELECT COUNT(*) n FROM edges WHERE json_extract(metadata,'$.synthesizedBy') = 'era-dispatch'`
        )
        .get() as { n: number }).n;
    const before = countDispatch();

    // A new command lands in a new file. The dispatcher that reaches it did not
    // change, so it emits no new reference — the fan-out has to be re-derived
    // from the current function set or the new command is unreachable forever.
    fs.writeFileSync(path.join(dir, 'ERB', 'COM105.ERB'), ['@COM_ABLE105', 'RETURN 1'].join('\r\n'));
    await cg.sync();

    const targets = db
      .prepare(
        `SELECT t.name name FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
         WHERE s.name = 'TRAIN_LOOP' AND json_extract(e.metadata,'$.synthesizedBy') = 'era-dispatch'`
      )
      .all()
      .map((r: { name: string }) => r.name)
      .sort();
    expect(targets).toEqual(['COM_ABLE103', 'COM_ABLE104', 'COM_ABLE105']);
    // Re-deriving must not double the edges that were already there.
    expect(countDispatch()).toBe(before + 1);
  });

  it('binds character-sheet rows to the same slots the scripts touch', () => {
    // Without the sheets, "who writes TALENT:10" only finds runtime code and
    // every initial value looks source-less. The sheet writes by number AND by
    // CSV name, and both must land on the script-visible slot nodes; 基礎 rows
    // land on BASE slots because the engine's MAXBASE is named through base.csv.
    const rows = (cg as unknown as { db: { db: any } }).db.db
      .prepare(
        `SELECT t.qualified_name qn FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE s.qualified_name = 'ERA::CHARA::1002' AND e.kind = 'writes'
         ORDER BY t.qualified_name`
      )
      .all()
      .map((r: { qn: string }) => r.qn);
    expect(rows).toContain('ERA::SLOT::TALENT:10');
    expect(rows).toContain('ERA::SLOT::ABL:10');
    expect(rows).toContain('ERA::SLOT::BASE:0');
  });

  it('anchors every claim on a path and line', () => {
    const db = (cg as unknown as { db: { db: any } }).db.db;
    const row = db
      .prepare(`SELECT file_path, start_line, name FROM nodes WHERE qualified_name = 'ERA::SLOT::ITEM:40'`)
      .get() as { file_path: string; start_line: number; name: string };
    expect(row.name).toBe('大镜子');
    expect(row.file_path.replace(/\\/g, '/')).toBe('CSV/Item.csv');
    expect(row.start_line).toBe(1);
  });
});
