import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../../types';
import { generateNodeId } from '../tree-sitter-helpers';
import { getEraProfile } from './profile';
import { EraProfileIndex, EraVariable } from './types';
import { prepareLines } from './lines';
import { qualifySlot } from './names';

/**
 * Ontology CSV extractor.
 *
 * These CSVs are what makes an Era game readable: `TEQUIP:羞耻play` means
 * nothing until Tequip.csv says row 43 is called 羞耻play. Each row becomes one
 * named slot node, so an ERB reference by name and a reference by number land
 * on the same symbol and "who touches this slot" becomes one query.
 *
 * Row format is fixed by the engine (ConstantData.loadDataTo): split on `,`,
 * field 0 must parse as an int, field 1 is the name verbatim, field 2 is an
 * optional numeric payload (only Item.csv uses it, for the price). Anything
 * else — banner comments, section headers, blank lines — is skipped exactly as
 * the engine skips it, so the node set matches what the game actually loaded.
 *
 * Several variables usually share one CSV (ITEM/ITEMSALES/ITEMPRICE all name
 * through Item.csv; PALAM/JUEL/GOTJUEL/CUP/CDOWN/UP/DOWN through Palam.csv).
 * Emitting a node per variable would duplicate every row up to seven times, so
 * a row is emitted once under a single primary variable and the resolver maps
 * the other variables onto it.
 */
export class EraCsvExtractor {
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
      const fileNode = this.createFileNode();
      this.parseRows(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `Era CSV extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  /**
   * The variable a row is filed under.
   *
   * Prefer the variable named after the file (Abl.csv -> ABL), which is the one
   * ERB overwhelmingly writes. Otherwise take the alphabetically first binder so
   * the choice is stable across runs; when nothing binds, fall back to the
   * uppercased basename so rows still get a namespace instead of being dropped.
   */
  private primaryVariable(): { name: string; variable: EraVariable | null } {
    const base = this.baseName();
    const stem = base.replace(/\.[^.]*$/, '').toUpperCase();
    const binders = this.index.csvToVariables.get(base.toLowerCase()) ?? [];
    const exact = binders.find((v) => v.name === stem);
    if (exact) return { name: exact.name, variable: exact };
    if (binders.length) {
      const sorted = [...binders].sort((a, b) => a.name.localeCompare(b.name));
      return { name: sorted[0]!.name, variable: sorted[0]! };
    }
    return { name: stem, variable: null };
  }

  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.baseName(),
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'eracsv',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  private parseRows(fileNodeId: string): void {
    const { name: varName, variable } = this.primaryVariable();
    const carriesPayload = varName === 'ITEM';
    const seen = new Set<number>();
    const now = Date.now();

    for (const line of prepareLines(this.source)) {
      if (line.blank) continue;
      const fields = line.code.split(',');
      if (fields.length < 2) continue;

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
        this.errors.push({
          message: `duplicate slot ${varName}:${index} (${displayName}) — the engine keeps the last definition`,
          filePath: this.filePath,
          line: line.line,
          severity: 'warning',
          code: 'era_duplicate_slot',
        });
      }
      seen.add(index);

      const qualifiedName = qualifySlot(varName, index);
      const nodeId = generateNodeId(this.filePath, 'constant', qualifiedName, line.line);
      const payload = carriesPayload && fields.length >= 3 ? fields[2]!.trim() : '';

      this.nodes.push({
        id: nodeId,
        kind: 'constant',
        name: displayName,
        qualifiedName,
        filePath: this.filePath,
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

      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }
}
