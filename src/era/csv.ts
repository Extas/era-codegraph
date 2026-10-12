import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from '../extraction/tree-sitter-helpers';
import { getEraProfile, isEraCharaCsv, EraVariable } from './profile';
import { PreparedLine, prepareLines } from './lines';
import { qualifySlot, qualifyVariable, refVariable } from './names';

/** All engine CSV formats share comment handling, line numbers and comma fields. */
interface CsvRow {
  line: PreparedLine;
  fields: string[];
}

const GAMEBASE_KEYS = new Set([
  'コード', 'バージョン', 'バージョン違い認める', 'タイトル', '作者', '製作年',
  '追加情報', '最初からいるキャラ', 'アイテムなし', 'ウィンドウタイトル',
  'CODE', 'VERSION', 'ALLOWVERSION', 'TITLE', 'AUTHOR', 'INFO', 'YEAR',
]);

export const ENGINE_ANCHOR_FILE = 'gamebase.csv';

/** Is this the file the engine vocabulary is anchored on? */
export function isEraEngineAnchor(filePath: string): boolean {
  return filePath.replace(/\\/g, '/').toLowerCase() === `csv/${ENGINE_ANCHOR_FILE}`;
}


/** Ontology slots, character initializers and the engine vocabulary share one row model. */
export function extractEraCsv(filePath: string, source: string): ExtractionResult {
  const profileIndex = getEraProfile();
  const startTime = Date.now();
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const errors: ExtractionError[] = [];
  const lines = prepareLines(source);
  const rows: CsvRow[] = [];
  for (const line of lines) {
    if (line.blank) continue;
    const fields = line.code.split(',');
    if (fields.length >= 2) rows.push({ line, fields });
  }
  const charaSheet = isEraCharaCsv(filePath);
  const engineAnchor = isEraEngineAnchor(filePath);
  const fileNode: Node = {
    id: generateNodeId(filePath, 'file', filePath, 1),
    kind: 'file', name: baseName(), qualifiedName: filePath, filePath,
    language: 'eracsv', startLine: 1, endLine: lines.length,
    startColumn: 0,
    endColumn: charaSheet || engineAnchor ? 0 : (source.slice(source.lastIndexOf('\n') + 1).length),
    updatedAt: Date.now(),
  };
  try {
    nodes.push(fileNode);
    if (charaSheet) parseSheet();
    else if (engineAnchor) {
      emitGameIdentity(fileNode.id);
      emitBuiltinVariables(fileNode.id);
    } else parseRows(fileNode.id);
  } catch (error) {
    const format = charaSheet ? 'chara' : engineAnchor ? 'engine' : 'CSV';
    errors.push({
      message: 'Era ' + format + ' extraction error: ' + (error instanceof Error ? error.message : String(error)),
      filePath, severity: 'error', code: 'parse_error',
    });
  }
  return { nodes, edges, unresolvedReferences, errors, durationMs: Date.now() - startTime };

  function baseName(): string {
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.slice(normalized.lastIndexOf('/') + 1);
  }

  function primaryVariable(): { name: string; variable: EraVariable | null } {
    const base = baseName();
    const stem = base.replace(/\.[^.]*$/, '').toUpperCase();
    const binders = profileIndex.csvToVariables.get(base.toLowerCase()) ?? [];
    const exact = binders.find((v) => v.name === stem);
    if (exact) return { name: exact.name, variable: exact };
    if (binders.length) {
      const sorted = [...binders].sort((a, b) => a.name.localeCompare(b.name));
      return { name: sorted[0]!.name, variable: sorted[0]! };
    }
    return { name: stem, variable: null };
  }

  function parseRows(fileNodeId: string): void {
    const { name: varName, variable } = primaryVariable();
    const carriesPayload = varName === 'ITEM';
    const seen = new Set<number>();
    const now = Date.now();

    for (const { line, fields } of rows) {

      const index = Number.parseInt(fields[0]!.trim(), 10);
      if (!Number.isInteger(index) || index < 0) continue;
      if (!/^\s*[-+]?\d+\s*$/.test(fields[0]!)) continue;

      // The engine keeps the name verbatim, so an ERB lookup matches the raw
      // string. Display and search want it tidy, so the node carries the
      // trimmed form as `name` and the raw form stays recoverable from the file.
      const rawName = fields[1]!;
      const displayName = rawName.trim();
      if (!displayName) continue;

      // A duplicate index is a real defect the engine warns about and the last
      // row wins. Record it so the graph does not silently show two truths.
      if (seen.has(index)) {
        errors.push({
          message: `duplicate slot ${varName}:${index} (${displayName}) — the engine keeps the last definition`,
          filePath: filePath,
          line: line.line,
          severity: 'warning',
          code: 'era_duplicate_slot',
        });
      }
      seen.add(index);

      const qualifiedName = qualifySlot(varName, index);
      const nodeId = generateNodeId(filePath, 'constant', qualifiedName, line.line);
      const payload = carriesPayload && fields.length >= 3 ? fields[2]!.trim() : '';

      nodes.push({
        id: nodeId,
        kind: 'constant',
        name: displayName,
        qualifiedName,
        filePath: filePath,
        language: 'eracsv',
        startLine: line.line,
        endLine: line.line,
        startColumn: 0,
        endColumn: line.code.length,
        signature: payload ? `${varName}:${index} = ${displayName} (${payload})` : `${varName}:${index} = ${displayName}`,
        docstring: line.comment || undefined,
        // Per-character variables are indexed `VAR:chara:slot`; recording it on
        // the slot lets a consumer tell a character fact from a global one.
        isStatic: variable?.perCharacter ?? false,
        updatedAt: now,
      });

      edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }

  function parseSheet(): void {
    const now = Date.now();

    // First pass: identity. The number can come from the 番号 row or, as the
    // engine also allows, from the digits right after `Chara` in the filename.
    let number = '';
    let name = '';
    const identity: string[] = [];
    for (const { fields } of rows) {
      const key = fields[0]!.trim().toUpperCase();
      const value = fields[1]!.trim();
      if (!profileIndex.charaIdentityKeys.has(key)) continue;
      if (key === '番号' || key === 'NO') number = value;
      else if (key === '名前' || key === 'NAME') name = value;
      if (value) identity.push(`${fields[0]!.trim()}=${value}`);
    }
    if (!number) {
      const fromFile = baseName().match(/^chara[^0-9]*([0-9]+)/i);
      number = fromFile?.[1] ?? '';
    }

    const stem = baseName().replace(/\.[^.]*$/, '');
    const qualifiedName = `ERA::CHARA::${number || stem}`;
    const sheetId = generateNodeId(filePath, 'module', qualifiedName, 1);
    const fileId = fileNode.id;

    nodes.push({
      id: sheetId,
      kind: 'module',
      name: name || stem,
      qualifiedName,
      filePath: filePath,
      language: 'eracsv',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: 0,
      signature: `chara ${number || '?'}${name ? ` ${name}` : ''}`,
      docstring: identity.length ? identity.join('\n') : undefined,
      isStatic: true,
      updatedAt: now,
    });
    edges.push({ source: fileId, target: sheetId, kind: 'contains' });

    // Second pass: one write per (variable, index) pair, first line kept, the
    // same dedup contract script extraction uses.
    const seen = new Set<string>();
    const unknownKeys = new Set<string>();
    for (const { line, fields } of rows) {
      const rawKey = fields[0]!.trim();
      const key = rawKey.toUpperCase();
      if (profileIndex.charaIdentityKeys.has(key) || profileIndex.charaIgnoredKeys.has(key)) continue;

      const variable = profileIndex.charaKeys.get(key);
      if (!variable) {
        // The engine warns once per uninterpretable key; so do we.
        if (rawKey && !unknownKeys.has(rawKey)) {
          unknownKeys.add(rawKey);
          errors.push({
            message: `chara sheet key the engine cannot interpret: ${rawKey}`,
            filePath: filePath,
            line: line.line,
            severity: 'warning',
            code: 'era_unknown_chara_key',
          });
        }
        continue;
      }

      // The index token may be a number or a CSV name; the resolver settles
      // both against the same slot dictionaries the scripts use. A missing
      // index (`素質,,1`) is an engine warning, not a write.
      const indexToken = fields[1]!.trim();
      if (!indexToken) continue;

      const chain = `${variable}:${indexToken}`;
      if (seen.has(chain)) continue;
      seen.add(chain);
      unresolvedReferences.push({
        fromNodeId: sheetId,
        referenceName: refVariable(chain),
        referenceKind: 'writes',
        line: line.line,
        column: 0,
        filePath: filePath,
        language: 'eracsv',
      });
    }
  }

  function emitGameIdentity(fileNodeId: string): void {
    const now = Date.now();
    for (const { line } of rows) {
      const comma = line.code.indexOf(',');
      const key = line.code.slice(0, comma).trim();
      const value = line.code.slice(comma + 1).trim();
      if (!key || !GAMEBASE_KEYS.has(key)) continue;
      const qualifiedName = `ERA::GAME::${key}`;
      const id = generateNodeId(filePath, 'constant', qualifiedName, line.line);
      nodes.push({
        id,
        kind: 'constant',
        name: key,
        qualifiedName,
        filePath: filePath,
        language: 'eracsv',
        startLine: line.line,
        endLine: line.line,
        startColumn: 0,
        endColumn: line.code.length,
        signature: `${key} = ${value}`,
        updatedAt: now,
      });
      edges.push({ source: fileNodeId, target: id, kind: 'contains' });
    }
  }

  function emitBuiltinVariables(fileNodeId: string): void {
    const now = Date.now();
    const { profile } = profileIndex;
    for (const variable of profile.variables) {
      const qualifiedName = qualifyVariable(variable.name);
      const id = generateNodeId(filePath, 'variable', qualifiedName, 1);
      const traits = [
        variable.valueType,
        variable.dimensions ? `${variable.dimensions}d` : 'scalar',
        variable.perCharacter ? 'per-character' : 'global',
        variable.scope,
      ];
      if (variable.readOnly) traits.push('read-only');
      if (variable.backingCsv) traits.push(`csv:${variable.backingCsv}`);

      nodes.push({
        id,
        kind: 'variable',
        name: variable.name,
        qualifiedName,
        filePath: filePath,
        language: 'eracsv',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        signature: `${variable.name} [${traits.join(', ')}]`,
        // Which engine build defines this variable is the whole provenance
        // claim; without it the node is an assertion about "Era" in general.
        docstring: `Emuera built-in. Engine ${profile.id} (${profile.engine.sha256.slice(0, 12)}).`,
        decorators: traits,
        isExported: true,
        // `save` variables persist across sessions; the rest are interpreter
        // state. That split is what separates a game fact from plumbing.
        isStatic: variable.scope === 'save',
        updatedAt: now,
      });
      edges.push({ source: fileNodeId, target: id, kind: 'contains' });
    }
  }

}
