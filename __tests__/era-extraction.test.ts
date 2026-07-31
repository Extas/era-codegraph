import { describe, it, expect } from 'vitest';
import { EraBasicExtractor } from '../src/extraction/era/erb-extractor';
import { EraCsvExtractor } from '../src/extraction/era/csv-extractor';
import { EraCharaExtractor } from '../src/extraction/era/chara-extractor';
import { EraEngineExtractor, isEraEngineAnchor } from '../src/extraction/era/engine-extractor';
import { getEraProfile, isEraCharaCsv, isEraOntologyCsv } from '../src/extraction/era/profile';
import { detectLanguage, isSourceFile } from '../src/extraction/grammars';
import { EDGE_KINDS, LANGUAGES } from '../src/types';

/**
 * The samples below are shaped after `COMF103_羞恥プレイ.ERB` in era-ym, the
 * behaviour a remake was blocked on: an availability check that reads eight
 * pieces of state, gates on an item, and is only ever reached through an
 * interpolated call. Each assertion names a question the graph must answer, not
 * an internal detail of the parser.
 */

const COM103 = [
  ';=============================================================================',
  ';羞耻play',
  ';=============================================================================',
  '@COM_ABLE103',
  'SIF !com_able_general(103)',
  '\tRETURN 0',
  ';羞耻play系扩展指令没有开启则不行',
  'SIF (FLAG:15 & 512) == 0',
  '\tRETURN 0',
  'SIF TEQUIP:羞耻play',
  '\tRETURN 1',
  'IF NO:PLAYER != 1036 || (FLAG:15 & 16384) == 0',
  '\tSIF TEQUIP:浴室play == 0 && ITEM:大镜子 == 0',
  '\t\tRETURN 0',
  'ENDIF',
  'SIF ABL:顺从 < 1',
  '\tRETURN 0',
  'SIF TFLAG:899 > 0',
  '\tRETURN 0',
  'RETURN 1',
  '',
  '@COM103',
  '#DIM local_gain',
  'PRINTFORML 用{ITEMNAME:大镜子}照出了{CALLNAME:TARGET}的样子',
  'local_gain = 10',
  'PALAM:TARGET:屈服 += local_gain',
  'TEQUIP:羞恥play = 1',
  'CALL COM_ABLE103',
  'TRYCALLFORM COM_ABLE{com_id}',
].join('\n');

function extractErb(source = COM103, filePath = 'ERB/TRAIN_COM/COMF103.ERB') {
  return new EraBasicExtractor(filePath, source).extract();
}

const refNames = (result: ReturnType<typeof extractErb>, kind: string) =>
  result.unresolvedReferences.filter((r) => r.referenceKind === kind).map((r) => r.referenceName);

describe('era language registration', () => {
  it('registers both Era languages and the data-flow edge kinds', () => {
    expect(LANGUAGES).toContain('erabasic');
    expect(LANGUAGES).toContain('eracsv');
    expect(EDGE_KINDS).toContain('reads');
    expect(EDGE_KINDS).toContain('writes');
  });

  it('claims .ERB only inside a game ERB tree, never a Rails template', () => {
    expect(isSourceFile('ERB/MAIN/SHOP/0MAIN.ERB')).toBe(true);
    expect(isSourceFile('ERB/const.ERH')).toBe(true);
    expect(detectLanguage('ERB/MAIN/SHOP/0MAIN.ERB', '@FUNC\nRETURN 0')).toBe('erabasic');
    // A Rails view is not under an ERB directory and must stay unindexed.
    expect(isSourceFile('app/views/users/index.html.erb')).toBe(false);
    // Even inside a directory called erb/, content decides.
    expect(detectLanguage('erb/index.erb', '<%= render @user %>')).toBe('unknown');
    // A comment-only or placeholder script is still EraBasic. Requiring a
    // positive marker would silently drop real source files from the index.
    expect(detectLanguage('ERB/MESSAGE/STUB.ERB', '﻿;test txt\r\n\r\n')).toBe('erabasic');
    expect(detectLanguage('ERB/MESSAGE/BANNER.ERB', '﻿;====\r\n;服药\r\n;====\r\n')).toBe('erabasic');
  });

  it('claims only the ontology CSVs the engine loads, in the game CSV directory', () => {
    expect(isEraOntologyCsv('CSV/Talent.csv')).toBe(true);
    expect(isEraOntologyCsv('CSV/Item.csv')).toBe(true);
    expect(isEraOntologyCsv('CSV/GameBase.csv')).toBe(true);
    // Juel.csv sits beside the others but the engine never loads it: JUEL is
    // named through Palam.csv. Deriving the list from the engine catches that.
    expect(isEraOntologyCsv('CSV/Juel.csv')).toBe(false);
    expect(isEraOntologyCsv('data/Item.csv')).toBe(false);
    expect(isEraOntologyCsv('reports/quarterly.csv')).toBe(false);
  });

  it('ignores the optional patch trees the engine never loads', () => {
    // era-ym ships `付属パッチ＆差し替え口上/…/ERB/EVENT/TOHO.ERB` and dialogue
    // templates under `口上テンプレⅠ/`. Emuera reads only `<gamedir>/ERB`, so
    // indexing these invents a second definition of six functions the game
    // defines once, and offers phantoms as dispatch candidates.
    expect(isSourceFile('付属パッチ＆差し替え口上/1026 慧音/月齢パッチ/ERB/EVENT/TOHO.ERB')).toBe(false);
    expect(isSourceFile('口上テンプレⅠ/EVENT_KXX.ERB')).toBe(false);
    expect(isEraOntologyCsv('付属パッチ＆差し替え口上/1026 慧音/CSV/Talent.csv')).toBe(false);
    // Nesting under the real CSV/ is not a thing the engine reads either.
    expect(isEraOntologyCsv('CSV/chara/Talent.csv')).toBe(false);
  });
});

describe('engine profile', () => {
  const index = getEraProfile();

  it('is derived from a specific engine build, not from Era in general', () => {
    expect(index.profile.derived).toBe('source');
    expect(index.profile.engine.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries the csv bindings ERB name resolution depends on', () => {
    expect(index.variables.get('ABL')?.backingCsv?.toLowerCase()).toBe('abl.csv');
    expect(index.variables.get('TALENT')?.perCharacter).toBe(true);
    // Three variables read one table; the resolver has to fold them together.
    expect(index.variables.get('ITEMPRICE')?.backingCsv?.toLowerCase()).toBe('item.csv');
    expect(index.variables.get('ITEMPRICE')?.readOnly).toBe(true);
    expect(index.variables.get('ITEM')?.perCharacter).toBe(false);
  });

  it('marks interpolated call instructions', () => {
    expect(index.instructions.get('TRYCALLFORM')).toMatchObject({ kind: 'call', isForm: true, isTry: true });
    expect(index.instructions.get('CALL')).toMatchObject({ kind: 'call', isForm: false });
    // GOTO stays inside the function; it is control flow, not a dependency.
    expect(index.instructions.get('GOTO')?.kind).toBe('goto');
  });

  it('knows built-in expression functions so they are not read as game calls', () => {
    expect(index.methods.has('MAX')).toBe(true);
    expect(index.methods.has('CSVNAME')).toBe(true);
  });
});

describe('EraBasic extraction', () => {
  it('emits one function per @definition with its comment banner', () => {
    const result = extractErb();
    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.map((f) => f.name)).toEqual(['COM_ABLE103', 'COM103']);
    expect(functions[0]!.qualifiedName).toBe('ERA::FN::COM_ABLE103');
    expect(functions[0]!.docstring).toContain('羞耻play');
    // The banner rules are layout, not documentation.
    expect(functions[0]!.docstring).not.toContain('====');
  });

  it('records every piece of state a guard reads', () => {
    const result = extractErb();
    const reads = refNames(result, 'reads');
    expect(reads).toContain('ERA::REF::FLAG:15');
    expect(reads).toContain('ERA::REF::TEQUIP:羞耻play');
    expect(reads).toContain('ERA::REF::ITEM:大镜子');
    expect(reads).toContain('ERA::REF::ABL:顺从');
    expect(reads).toContain('ERA::REF::TFLAG:899');
    expect(reads).toContain('ERA::REF::NO:PLAYER');
  });

  it('separates writes from reads, and both from a comparison', () => {
    const result = extractErb();
    const writes = refNames(result, 'writes');
    expect(writes).toContain('ERA::REF::TEQUIP:羞恥play');
    expect(writes).toContain('ERA::REF::PALAM:TARGET:屈服');
    // `SIF TEQUIP:浴室play == 0` is a guard; treating it as a write would
    // invert the most important edge in the graph.
    expect(writes).not.toContain('ERA::REF::TEQUIP:浴室play');
    // A compound assignment reads the target as well as writing it.
    expect(refNames(result, 'reads')).toContain('ERA::REF::PALAM:TARGET:屈服');
  });

  it('keeps a function-local #DIM out of the global read set', () => {
    const result = extractErb();
    const all = result.unresolvedReferences.map((r) => r.referenceName);
    expect(all).not.toContain('ERA::REF::local_gain');
    expect(result.nodes.some((n) => n.qualifiedName === 'ERA::LOCAL::COM103::local_gain')).toBe(true);
  });

  it('records static and interpolated calls differently', () => {
    const result = extractErb();
    const calls = refNames(result, 'calls');
    expect(calls).toContain('ERA::FN::COM_ABLE103');
    expect(calls).toContain('ERA::FN::com_able_general');
    // The literal prefix is all that survives an interpolated target.
    expect(calls).toContain('ERA::DYN::COM_ABLE|');
  });

  it('reads FORM text only through its interpolations', () => {
    const result = extractErb();
    const reads = refNames(result, 'reads');
    expect(reads).toContain('ERA::REF::ITEMNAME:大镜子');
    expect(reads).toContain('ERA::REF::CALLNAME:TARGET');
    // The surrounding Chinese prose must not become symbols.
    expect(reads.some((r) => r.includes('照出了'))).toBe(false);
  });

  it('marks the traits a behaviour record has to state', () => {
    const result = extractErb();
    const able = result.nodes.find((n) => n.name === 'COM_ABLE103')!;
    expect(able.decorators).toEqual(expect.arrayContaining([expect.stringMatching(/^branches:/)]));
    const com = result.nodes.find((n) => n.name === 'COM103')!;
    expect(com.decorators).toEqual(expect.arrayContaining([expect.stringMatching(/^dynamic-dispatch:/)]));
  });

  it('reports a random draw where one happens and nowhere else', () => {
    const withRand = extractErb('@ROLL\nLOCAL = RAND:100\nRETURN LOCAL');
    expect(withRand.nodes.find((n) => n.name === 'ROLL')!.decorators).toContain('random');
    expect(extractErb().nodes.find((n) => n.name === 'COM103')!.decorators ?? []).not.toContain('random');
  });

  it('treats a brace-only line as a comment block but never an interpolation', () => {
    const source = [
      '@F',
      '{',
      'ABL:hidden = 1',
      '}',
      'TRYCALLFORM COM_ABLE{com_id}',
    ].join('\n');
    const result = extractErb(source, 'ERB/F.ERB');
    expect(refNames(result, 'writes')).not.toContain('ERA::REF::ABL:hidden');
    expect(refNames(result, 'calls')).toContain('ERA::DYN::COM_ABLE|');
  });

  it('keeps the text after the last hole so a pattern cannot over-match', () => {
    const result = extractErb('@F\nCALLFORM EVENT_K{no}_A', 'ERB/F.ERB');
    expect(refNames(result, 'calls')).toContain('ERA::DYN::EVENT_K|_A');
  });

  it('strips a FORM call argument list out of the dynamic suffix', () => {
    // Verbatim shapes from the game. The argument list after the built target
    // must not ride into the suffix, or the whole RANDOM_CHARA_*_SET_ family
    // matches nothing; and a paren inside a hole is part of the target.
    const result = extractErb(
      [
        '@F',
        'TRYCALLFORM RANDOM_CHARA_TALENT_SET_%kind%(chara)',
        'CALLFORM daily_event_%name%(ARG)',
        'TRYCALLFORM COM_%id%_SUB(a, b)',
      ].join('\n'),
      'ERB/F.ERB'
    );
    const calls = refNames(result, 'calls');
    expect(calls).toContain('ERA::DYN::RANDOM_CHARA_TALENT_SET_|');
    expect(calls).toContain('ERA::DYN::daily_event_|');
    expect(calls).toContain('ERA::DYN::COM_|_SUB');
    expect(calls.some((c) => c.includes('('))).toBe(false);
    // The stripped argument lists are still scanned as expressions.
    expect(refNames(result, 'reads')).toContain('ERA::REF::chara');
  });

  it('declares an ERH global as a global, and marks SAVEDATA ones', () => {
    const result = extractErb(
      '#DIM 残存PALAM, 33\n#DIM CHARADATA SAVEDATA custom_talent, 30\n#DIM CONST MAX_KOJO = 3',
      'ERB/variable.ERH'
    );
    const names = result.nodes.map((n) => n.qualifiedName);
    expect(names).toContain('ERA::VAR::残存PALAM');
    expect(names).toContain('ERA::VAR::custom_talent');
    expect(names).toContain('ERA::VAR::MAX_KOJO');
    expect(result.nodes.find((n) => n.name === 'custom_talent')!.isStatic).toBe(true);
    expect(result.nodes.find((n) => n.name === 'MAX_KOJO')!.kind).toBe('constant');
  });

  it('treats the right-hand side of a string assignment as display text', () => {
    // Verbatim from COMF025_逆レイプ.ERB. `为处女(...)` is prose, not a call;
    // only the two interpolations are code.
    const result = extractErb(
      '@F\nRESULTS = %RESULTS% %CALLNAME:PLAYER%为处女({LOCAL:99})',
      'ERB/F.ERB'
    );
    expect(refNames(result, 'calls')).not.toContain('ERA::FN::为处女');
    expect(refNames(result, 'reads')).toContain('ERA::REF::CALLNAME:PLAYER');
    expect(refNames(result, 'writes')).toContain('ERA::REF::RESULTS');
  });

  it('still evaluates the right-hand side when the script asks for it', () => {
    // `'=` is the explicit expression form for a string variable.
    const result = extractErb("@F\n#DIMS name\nRESULTS '= CSVNAME(TARGET)\nRESULTS = 前缀%name%", 'ERB/F.ERB');
    expect(refNames(result, 'reads')).toContain('ERA::REF::TARGET');
    // …and an integer target is always an expression.
    const int = extractErb('@F\nTFLAG:409 = MAX(TFLAG:409 - 1, 100)', 'ERB/F.ERB');
    expect(refNames(int, 'reads')).toContain('ERA::REF::TFLAG:409');
  });

  it('reads a DATA block as display text, not as code', () => {
    // Every PRINTDATA block is a list of literal lines; a game has thousands.
    const result = extractErb(
      ['@F', 'PRINTDATA', '\tDATA 「Wza-y\'ei! Rhan-Tegoth……」', '\tDATAFORM {CALLNAME:TARGET}低声说', 'ENDDATA'].join('\n'),
      'ERB/F.ERB'
    );
    const reads = refNames(result, 'reads');
    expect(reads.some((r) => r.includes('Wza'))).toBe(false);
    expect(reads.some((r) => r.includes('低声说'))).toBe(false);
    // DATAFORM interpolations are still code.
    expect(reads).toContain('ERA::REF::CALLNAME:TARGET');
  });

  it('keeps a slot name that contains punctuation an identifier would split on', () => {
    // Talent.csv really does define 淫核／淫茎, and Flag.csv 通常画面画像：表示.
    // Splitting at the fullwidth punctuation leaves a fragment matching no row.
    const result = extractErb('@F\nSIF TALENT:ARG:淫核／淫茎\n\tGLOBAL:4010 = FLAG:通常画面画像：表示', 'ERB/F.ERB');
    const reads = refNames(result, 'reads');
    expect(reads).toContain('ERA::REF::TALENT:ARG:淫核／淫茎');
    expect(reads).toContain('ERA::REF::FLAG:通常画面画像：表示');
  });

  it('does not let a paren inside an interpolation truncate a dynamic target', () => {
    const result = extractErb(
      '@F\nTRYCALLFORM KOJO_%kojo_index(TARGET)%_MESSAGE_SUB_EVENT_SCENE850, LOCAL:14',
      'ERB/F.ERB'
    );
    expect(refNames(result, 'calls')).toContain('ERA::DYN::KOJO_|_MESSAGE_SUB_EVENT_SCENE850');
    // The interpolation is code; the suffix around it is not.
    expect(refNames(result, 'reads')).toContain('ERA::REF::TARGET');
    expect(refNames(result, 'reads')).not.toContain('ERA::REF::_MESSAGE_SUB_EVENT_SCENE850');
  });

  it('declares a #DEFINE macro so its uses have somewhere to point', () => {
    const header = extractErb('#DEFINE height_normal\t0\n#DEFINE window_train\t100', 'ERB/MAIN/body_data.ERH');
    const macro = header.nodes.find((n) => n.name === 'height_normal')!;
    expect(macro.kind).toBe('constant');
    expect(macro.qualifiedName).toBe('ERA::VAR::height_normal');
    expect(macro.decorators).toContain('DEFINE');
    // The use site reads it like any other name.
    const use = extractErb('@F\nSIF height_category(TARGET) < height_normal\n\tRETURN 0', 'ERB/F.ERB');
    expect(refNames(use, 'reads')).toContain('ERA::REF::height_normal');
  });

  it('deduplicates repeated access to the same slot', () => {
    const result = extractErb('@F\nSIF ABL:顺从 > 1\n\tABL:顺从 = 2\nSIF ABL:顺从 > 3\n\tRETURN 1', 'ERB/F.ERB');
    expect(refNames(result, 'reads').filter((r) => r === 'ERA::REF::ABL:顺从')).toHaveLength(1);
    expect(refNames(result, 'writes').filter((r) => r === 'ERA::REF::ABL:顺从')).toHaveLength(1);
  });
});

describe('ontology CSV extraction', () => {
  const ITEM_CSV = [
    '﻿;道具',
    '0,现金,0,;不是道具',
    '40,大镜子,70,;可以进行羞耻play',
    '49,浴室用大镜子,80000,;防雾处理',
    ';这一行只是注释',
    '不是数字,忽略我',
  ].join('\r\n');

  it('turns each engine-loadable row into a named slot', () => {
    const result = new EraCsvExtractor('CSV/Item.csv', ITEM_CSV).extract();
    const slots = result.nodes.filter((n) => n.kind === 'constant');
    expect(slots.map((s) => s.qualifiedName)).toEqual([
      'ERA::SLOT::ITEM:0',
      'ERA::SLOT::ITEM:40',
      'ERA::SLOT::ITEM:49',
    ]);
    const mirror = slots.find((s) => s.name === '大镜子')!;
    expect(mirror.startLine).toBe(3);
    // Item.csv's third column is the price, which only the engine says.
    expect(mirror.signature).toContain('70');
    expect(mirror.docstring).toContain('羞耻play');
  });

  it('files rows that several variables share under one primary variable', () => {
    const palam = new EraCsvExtractor('CSV/Palam.csv', '0,恭順\n1,屈服').extract();
    // JUEL, GOTJUEL, CUP, CDOWN, UP and DOWN all read Palam.csv; emitting a
    // node per variable would multiply every row six times.
    expect(palam.nodes.filter((n) => n.kind === 'constant').map((n) => n.qualifiedName)).toEqual([
      'ERA::SLOT::PALAM:0',
      'ERA::SLOT::PALAM:1',
    ]);
  });

  it('reports a duplicate index instead of showing two truths silently', () => {
    const result = new EraCsvExtractor('CSV/Abl.csv', '10,顺从\n10,再定义').extract();
    expect(result.errors.map((e) => e.code)).toContain('era_duplicate_slot');
  });
});

describe('character sheets', () => {
  const SHEET = [
    '﻿番号,1002',
    '名前,テスト',
    '呼び名,テスト,',
    '基礎,0,2500,',
    '素質,120,1,;男性',
    '素質,52,;舌头灵活',
    '能力,顺从,5',
    'フラグ,3200,100,;种族',
    'CSTR,31,テスト,',
    '相性,1001,50',
    '助手,1',
    '謎のキー,1',
  ].join('\r\n');

  it('turns rows into writes under the engine key table', () => {
    const result = new EraCharaExtractor('CSV/chara/Chara1002 テスト.csv', SHEET).extract();
    const sheet = result.nodes.find((n) => n.kind === 'module')!;
    expect(sheet.qualifiedName).toBe('ERA::CHARA::1002');
    expect(sheet.name).toBe('テスト');

    const writes = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'writes')
      .map((r) => r.referenceName);
    // 基礎 initializes MAXBASE, not BASE — the engine's own surprise.
    expect(writes).toContain('ERA::REF::MAXBASE:0');
    expect(writes).toContain('ERA::REF::TALENT:120');
    // A comment-only third field means value 1; the row still writes.
    expect(writes).toContain('ERA::REF::TALENT:52');
    // The index may be a CSV name, settled later by the resolver.
    expect(writes).toContain('ERA::REF::ABL:顺从');
    expect(writes).toContain('ERA::REF::CFLAG:3200');
    expect(writes).toContain('ERA::REF::CSTR:31');
    expect(writes).toContain('ERA::REF::RELATION:1001');
    // Identity and engine-discarded keys write nothing.
    expect(writes.some((w) => w.includes('番号') || w.includes('助手'))).toBe(false);
    // A key the engine cannot interpret is warned about, once.
    expect(result.errors.filter((e) => e.code === 'era_unknown_chara_key')).toHaveLength(1);
  });

  it('recovers the number from the filename when the 番号 row is missing', () => {
    const result = new EraCharaExtractor('CSV/Chara500 あなた.csv', '名前,あなた\r\n素質,120,1').extract();
    expect(result.nodes.find((n) => n.kind === 'module')!.qualifiedName).toBe('ERA::CHARA::500');
  });

  it('claims Chara*.csv at any depth under CSV/, and nothing else', () => {
    expect(isEraCharaCsv('CSV/chara/1000_win東方/Chara1000 あなた.csv')).toBe(true);
    expect(isEraCharaCsv('CSV/Chara500 あなた.csv')).toBe(true);
    expect(isEraCharaCsv('CSV/Talent.csv')).toBe(false);
    expect(isEraCharaCsv('data/Chara1.csv')).toBe(false);
    expect(detectLanguage('CSV/chara/Chara1000.csv')).toBe('eracsv');
    expect(isSourceFile('CSV/chara/Chara1000.csv')).toBe(true);
  });
});

describe('engine vocabulary anchor', () => {
  it('recognises GameBase.csv as the anchor', () => {
    expect(isEraEngineAnchor('CSV/GameBase.csv')).toBe(true);
    expect(isEraEngineAnchor('CSV/Item.csv')).toBe(false);
  });

  it('materialises the built-in variables no game file declares', () => {
    const result = new EraEngineExtractor('CSV/GameBase.csv', 'コード,1000\nタイトル,era-ym').extract();
    const names = result.nodes.filter((n) => n.kind === 'variable').map((n) => n.qualifiedName);
    // era-ym ships no Tflag.csv, so TFLAG exists only because the engine says so.
    expect(names).toContain('ERA::VAR::TFLAG');
    expect(names).toContain('ERA::VAR::MONEY');
    expect(names).toContain('ERA::VAR::ABL');
    const tflag = result.nodes.find((n) => n.name === 'TFLAG')!;
    expect(tflag.docstring).toContain('Emuera built-in');
    expect(result.nodes.some((n) => n.qualifiedName === 'ERA::GAME::タイトル')).toBe(true);
  });
});
