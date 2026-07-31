import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../../types';
import { generateNodeId } from '../tree-sitter-helpers';
import { getEraProfile } from './profile';
import { EraProfileIndex } from './types';
import { prepareLines } from './lines';
import { refVariable } from './names';

/**
 * Character-sheet (`Chara*.csv`) extractor.
 *
 * A sheet is where a character's initial facts come from: `素質,120,1` sets
 * TALENT:120, `基礎,0,2500` sets MAXBASE:0, `能力,顺从,5` sets ABL by name.
 * Without the sheets in the graph, "who writes TALENT:111" only ever finds the
 * runtime randomizers, and every initial value looks source-less — the exact
 * hole the migration work kept hitting when tracing a slot back to its origin.
 *
 * Each sheet becomes one `module` node (`ERA::CHARA::<no>`) whose writes flow
 * through the same unresolved-reference machinery as script writes, so a row
 * naming a slot by CSV name and a row using the number land on the same slot
 * node the scripts touch. Which key initializes which variable is engine
 * truth taken from the profile, not guessed here; it holds real surprises
 * (`基礎` writes MAXBASE, `珠` is named through palam.csv).
 *
 * Values are deliberately NOT stored. The graph answers who writes a slot and
 * where; the value lives on the cited CSV line, which is what a Migration
 * Record anchors anyway.
 */
export class EraCharaExtractor {
  private filePath: string;
  private source: string;
  private index: EraProfileIndex;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string, index?: EraProfileIndex) {
    this.filePath = filePath;
    this.source = source;
    this.index = index ?? getEraProfile();
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      this.parseSheet();
    } catch (error) {
      this.errors.push({
        message: `Era chara extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    }
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private baseName(): string {
    const normalized = this.filePath.replace(/\\/g, '/');
    return normalized.slice(normalized.lastIndexOf('/') + 1);
  }

  private parseSheet(): void {
    const lines = prepareLines(this.source);
    const now = Date.now();

    // First pass: identity. The number can come from the 番号 row or, as the
    // engine also allows, from the digits right after `Chara` in the filename.
    let number = '';
    let name = '';
    const identity: string[] = [];
    for (const line of lines) {
      if (line.blank) continue;
      const fields = line.code.split(',');
      if (fields.length < 2) continue;
      const key = fields[0]!.trim().toUpperCase();
      const value = fields[1]!.trim();
      if (!this.index.charaIdentityKeys.has(key)) continue;
      if (key === '番号' || key === 'NO') number = value;
      else if (key === '名前' || key === 'NAME') name = value;
      if (value) identity.push(`${fields[0]!.trim()}=${value}`);
    }
    if (!number) {
      const fromFile = this.baseName().match(/^chara[^0-9]*([0-9]+)/i);
      number = fromFile?.[1] ?? '';
    }

    const stem = this.baseName().replace(/\.[^.]*$/, '');
    const qualifiedName = `ERA::CHARA::${number || stem}`;
    const sheetId = generateNodeId(this.filePath, 'module', qualifiedName, 1);
    const fileId = generateNodeId(this.filePath, 'file', this.filePath, 1);

    this.nodes.push({
      id: fileId,
      kind: 'file',
      name: this.baseName(),
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'eracsv',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: 0,
      updatedAt: now,
    });
    this.nodes.push({
      id: sheetId,
      kind: 'module',
      name: name || stem,
      qualifiedName,
      filePath: this.filePath,
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
    this.edges.push({ source: fileId, target: sheetId, kind: 'contains' });

    // Second pass: one write per (variable, index) pair, first line kept, the
    // same dedup contract script extraction uses.
    const seen = new Set<string>();
    const unknownKeys = new Set<string>();
    for (const line of lines) {
      if (line.blank) continue;
      const fields = line.code.split(',');
      if (fields.length < 2) continue;
      const rawKey = fields[0]!.trim();
      const key = rawKey.toUpperCase();
      if (this.index.charaIdentityKeys.has(key) || this.index.charaIgnoredKeys.has(key)) continue;

      const variable = this.index.charaKeys.get(key);
      if (!variable) {
        // The engine warns once per uninterpretable key; so do we.
        if (rawKey && !unknownKeys.has(rawKey)) {
          unknownKeys.add(rawKey);
          this.errors.push({
            message: `chara sheet key the engine cannot interpret: ${rawKey}`,
            filePath: this.filePath,
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
      this.unresolvedReferences.push({
        fromNodeId: sheetId,
        referenceName: refVariable(chain),
        referenceKind: 'writes',
        line: line.line,
        column: 0,
        filePath: this.filePath,
        language: 'eracsv',
      });
    }
  }
}
