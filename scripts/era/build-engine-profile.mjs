#!/usr/bin/env node
/**
 * Engine Profile generator.
 *
 * An Era game's meaning is split across three layers: ERB scripts, ontology
 * CSVs, and the Emuera engine itself. The engine layer is the one that decides
 * WHICH csv names WHICH built-in variable and WHICH instruction is a call site.
 * Hard-coding those two tables into the extractors would spread one decision
 * across three modules and break on every other Emuera build (era-ym runs
 * 1.824 EEv55; hime runs something else). So the engine layer is reduced to a
 * declared data file, and this script is the only thing that knows how to
 * derive one from a decompiled engine.
 *
 * Input is an ILSpy/dnSpy decompile of Emuera.dll (extracted from the game's
 * single-file Emuera.exe). Three files carry everything we need:
 *
 *   VariableCode.cs      built-in variables, traits encoded as bit flags
 *   ConstantData.cs      csv file -> variable binding, and which argument
 *                        position the csv name occupies
 *   FunctionIdentifier.cs instruction table, incl. the call/goto flags that
 *                        say which instructions dispatch by a built string
 *
 * Usage:
 *   node scripts/era/build-engine-profile.mjs \
 *     --src <decompiled-dir> --engine <Emuera.exe> --out <profile.json>
 *
 * The decompile itself is copyrighted engine code and is NOT checked in. The
 * generated profile is a factual name/flag table, which is what the Migration
 * Record needs anchored.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const args = parseArgs(process.argv.slice(2));
if (!args.src || !args.engine || !args.out) {
  console.error('usage: build-engine-profile.mjs --src <dir> --engine <Emuera.exe> --out <file.json>');
  process.exit(2);
}

/** VariableCode bit flags, read off the enum's own `__NAME__` members. */
const FLAG_NAMES = [
  '__CAN_FORBID__',
  '__INTEGER__',
  '__STRING__',
  '__ARRAY_1D__',
  '__CHARACTER_DATA__',
  '__UNCHANGEABLE__',
  '__CALC__',
  '__EXTENDED__',
  '__LOCAL__',
  '__GLOBAL__',
  '__ARRAY_2D__',
  '__SAVE_EXTENDED__',
  '__ARRAY_3D__',
  '__CONSTANT__',
];

const srcDir = args.src;
const varCodePath = findFile(srcDir, 'VariableCode.cs');
const constDataPath = findFile(srcDir, 'ConstantData.cs');
const funcIdentPath = findFile(srcDir, 'FunctionIdentifier.cs');
const funcCodePath = findFile(srcDir, 'FunctionCode.cs');

const methodCreatorPath = findFile(srcDir, 'FunctionMethodCreator.cs');

const variables = parseVariableCode(read(varCodePath));
const { csvFiles, bindings } = parseConstantData(read(constDataPath));
const instructions = parseInstructions(read(funcIdentPath), read(funcCodePath));
const methods = parseMethods(read(methodCreatorPath));

// Attach each variable's csv binding. A variable with no binding indexes by
// number only, which is exactly the `unnamed slot` case downstream.
for (const [name, csv] of Object.entries(bindings.varToCsv)) {
  const v = variables.find((x) => x.name === name);
  if (v) {
    v.backingCsv = csv.file;
    v.nameArgIndex = csv.argIndex;
  }
}

const engineBytes = fs.readFileSync(args.engine);
const profile = {
  schemaVersion: 1,
  id: args.id || inferEngineId(args.engine),
  derived: 'source',
  engine: {
    path: path.basename(args.engine),
    sha256: crypto.createHash('sha256').update(engineBytes).digest('hex'),
    fileVersion: args.fileVersion || null,
    productVersion: args.productVersion || null,
  },
  // Emuera reads UTF-8 first and falls back to the ANSI code page; see
  // EncodingHandler.cs. Games ship either, so both are declared.
  encoding: { primary: 'utf-8', fallback: 'shift_jis' },
  csvFiles,
  variables: variables.sort((a, b) => a.name.localeCompare(b.name)),
  instructions: instructions.sort((a, b) => a.name.localeCompare(b.name)),
  methods: methods.sort(),
};

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(profile, null, 2) + '\n', 'utf8');

const bound = profile.variables.filter((v) => v.backingCsv).length;
const callInstr = profile.instructions.filter((i) => i.kind === 'call' || i.kind === 'callf').length;
console.log(
  `wrote ${args.out}\n` +
    `  variables    ${profile.variables.length} (${bound} csv-bound)\n` +
    `  csv files    ${profile.csvFiles.length}\n` +
    `  instructions ${profile.instructions.length} (${callInstr} call sites)`
);

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function findFile(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === name) return full;
    }
  }
  throw new Error(`not found under ${root}: ${name}`);
}

function inferEngineId(exePath) {
  return path.basename(exePath, path.extname(exePath)).toLowerCase();
}

/**
 * VariableCode is a flat `NAME = <int>,` enum where the high bits are traits
 * and the low 16 bits are the per-category ordinal. The trait flags are members
 * of the same enum (`__INTEGER__` etc.), so we read their values rather than
 * hard-coding them: a fork that renumbers still produces a correct profile.
 */
function parseVariableCode(src) {
  const raw = new Map();
  for (const m of src.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+)\s*,?\s*$/gm)) {
    raw.set(m[1], Number(m[2]));
  }
  const flags = {};
  for (const f of FLAG_NAMES) {
    if (raw.has(f)) flags[f] = raw.get(f);
  }
  const out = [];
  for (const [name, value] of raw) {
    // `__X__` members are flags and counters, not variables.
    if (name.startsWith('__')) continue;
    if (name.startsWith('NOTUSE_')) continue;
    const has = (f) => flags[f] !== undefined && (value & flags[f]) === flags[f];
    const dims = has('__ARRAY_3D__') ? 3 : has('__ARRAY_2D__') ? 2 : has('__ARRAY_1D__') ? 1 : 0;
    out.push({
      name,
      valueType: has('__STRING__') ? 'string' : 'int',
      dimensions: dims,
      perCharacter: has('__CHARACTER_DATA__'),
      readOnly: has('__UNCHANGEABLE__') || has('__CONSTANT__') || has('__CALC__'),
      scope: has('__LOCAL__') ? 'local' : has('__GLOBAL__') ? 'global' : 'save',
      backingCsv: null,
      nameArgIndex: null,
    });
  }
  return out;
}

/**
 * Two tables live in ConstantData:
 *   loadDataTo(Path.Combine(csvDir, "ABL.CSV"), 0, ...)  csv file -> dict slot
 *   case VariableCode.ABL: dictionary = nameToIntDics[0]; errPos = "abl.csv";
 *                                                        variable -> csv file
 * The switch is authoritative for the variable binding (several variables share
 * one csv: ITEM/ITEMSALES/ITEMPRICE all name through Item.csv), so we key off
 * it and use loadDataTo only to recover the on-disk file names.
 */
function parseConstantData(src) {
  const csvFiles = [];
  const slotToFile = new Map();
  for (const m of src.matchAll(/loadDataTo\(Path\.Combine\(csvDir,\s*"([^"]+)"\)\s*,\s*(\d+)/g)) {
    csvFiles.push(m[1]);
    slotToFile.set(Number(m[2]), m[1]);
  }

  const varToCsv = {};
  const body = sliceBetween(src, 'public Dictionary<string, int> GetKeywordDictionary', '\n\tpublic ');
  // Consecutive `case` labels share one body (ITEM/ITEMSALES/ITEMPRICE all fall
  // through to Item.csv), and the body assigns errPos before num, so the run is
  // only complete at `break`.
  let pending = [];
  let bodyLines = [];
  const flush = () => {
    if (pending.length) {
      const text = bodyLines.join('\n');
      const err = text.match(/errPos = "([^"]+)";/);
      const num = text.match(/num = (\d+);/);
      if (err) {
        const file = canonicalCsvName(err[1], csvFiles);
        const argIndex = num ? Number(num[1]) : null;
        for (const name of pending) varToCsv[name] = { file, argIndex };
      }
    }
    pending = [];
    bodyLines = [];
  };
  for (const line of body.split('\n')) {
    const caseMatch = line.match(/case VariableCode\.([A-Za-z_][A-Za-z0-9_]*):/);
    if (caseMatch) {
      // A case label after a body means the previous run ended without `break`.
      if (bodyLines.length) flush();
      pending.push(caseMatch[1]);
      continue;
    }
    if (/^\s*break;/.test(line)) {
      flush();
      continue;
    }
    if (pending.length) bodyLines.push(line);
  }
  flush();
  return { csvFiles, bindings: { varToCsv, slotToFile: Object.fromEntries(slotToFile) } };
}

/** `errPos` spellings vary in case ("Item.csv" vs "abl.csv"); the loadDataTo
 * list is the on-disk truth, so map back onto it. */
function canonicalCsvName(errPos, csvFiles) {
  const hit = csvFiles.find((f) => f.toLowerCase() === errPos.toLowerCase());
  return hit || errPos;
}

function sliceBetween(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) throw new Error(`marker not found: ${startMarker}`);
  const e = src.indexOf(endMarker, s + startMarker.length);
  return src.slice(s, e < 0 ? src.length : e);
}

/**
 * Every `addFunction(FunctionCode.X, ...)` registers a built-in instruction.
 * The interesting ones carry an instruction object whose constructor flags say
 * how the target is reached:
 *
 *   CALL_Instruction(form, isJump, isTry, isTryCatch)   calls an @FUNCTION
 *   GOTO_Instruction(form, isTry, isTryCatch)           jumps to a $LABEL
 *   CALLF_Instruction(form) / TRYCALLF_Instruction(form) calls a #FUNCTION
 *
 * `form: true` means the target name is built by string interpolation at run
 * time. That single bit is what tells the resolver a call site is dynamic.
 */
function parseInstructions(identSrc, codeSrc) {
  const declared = new Set();
  for (const m of codeSrc.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*(?:=\s*-?\d+\s*)?,\s*$/gm)) {
    if (!m[1].startsWith('__')) declared.add(m[1]);
  }

  const byName = new Map();
  for (const name of declared) {
    byName.set(name, { name, kind: 'other', isForm: false, isJump: false, isTry: false, isTryCatch: false });
  }

  const call = /addFunction\(FunctionCode\.([A-Z0-9_]+),\s*new CALL_Instruction\(form:\s*(true|false),\s*isJump:\s*(true|false),\s*isTry:\s*(true|false),\s*isTryCatch:\s*(true|false)\)/g;
  for (const m of identSrc.matchAll(call)) {
    byName.set(m[1], {
      name: m[1],
      kind: 'call',
      isForm: m[2] === 'true',
      isJump: m[3] === 'true',
      isTry: m[4] === 'true',
      isTryCatch: m[5] === 'true',
    });
  }

  const goto_ = /addFunction\(FunctionCode\.([A-Z0-9_]+),\s*new GOTO_Instruction\(form:\s*(true|false),\s*isTry:\s*(true|false),\s*isTryCatch:\s*(true|false)\)/g;
  for (const m of identSrc.matchAll(goto_)) {
    byName.set(m[1], {
      name: m[1],
      kind: 'goto',
      isForm: m[2] === 'true',
      isJump: true,
      isTry: m[3] === 'true',
      isTryCatch: m[4] === 'true',
    });
  }

  const callf = /addFunction\(FunctionCode\.([A-Z0-9_]+),\s*new (?:TRY)?CALLF_Instruction\(form:\s*(true|false)\)/g;
  for (const m of identSrc.matchAll(callf)) {
    byName.set(m[1], {
      name: m[1],
      kind: 'callf',
      isForm: m[2] === 'true',
      isJump: false,
      isTry: m[1].startsWith('TRY'),
      isTryCatch: false,
    });
  }

  for (const m of identSrc.matchAll(/addFunction\(FunctionCode\.([A-Z0-9_]+)/g)) {
    if (!byName.has(m[1])) {
      byName.set(m[1], { name: m[1], kind: 'other', isForm: false, isJump: false, isTry: false, isTryCatch: false });
    }
  }

  // CALLEVENT dispatches to EVENT* functions by a fixed name set, not by a
  // built string; it is a call site but not a dynamic one.
  const event = byName.get('CALLEVENT');
  if (event) event.kind = 'event';

  return [...byName.values()];
}

/**
 * Built-in expression functions (`MAX(a,b)`, `GETNUM(...)`, `CSVNAME(...)`),
 * registered as a dictionary initializer in FunctionMethodCreator. They share
 * the `name(args)` shape with game-defined `#FUNCTION`s, so without this list
 * every built-in call would be emitted as an unresolvable call to a missing
 * game function.
 */
function parseMethods(src) {
  const names = new Set();
  for (const m of src.matchAll(/^\s*\["([A-Za-z_][A-Za-z0-9_]*)"\]\s*=\s*new /gm)) {
    names.add(m[1]);
  }
  return [...names];
}
