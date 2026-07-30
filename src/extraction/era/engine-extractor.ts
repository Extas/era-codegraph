import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../../types';
import { generateNodeId } from '../tree-sitter-helpers';
import { getEraProfile } from './profile';
import { EraProfileIndex } from './types';
import { prepareLines } from './lines';
import { qualifyVariable } from './names';

/**
 * The engine layer, materialised in the graph.
 *
 * ERB reads and writes ~170 built-in variables that no file in the game
 * declares: `TFLAG`, `MONEY`, `ABL` and the rest exist because the engine
 * defines them. Without a node for each, "who writes MONEY" has nothing to
 * point at, and every access to a variable whose ontology CSV the game does not
 * ship (era-ym has no Tflag.csv) would resolve to nothing.
 *
 * The nodes are anchored on `CSV/GameBase.csv`, the one file every Era game is
 * required to have and the one that states which game this is. That makes the
 * engine vocabulary appear exactly once, deterministically, and puts it beside
 * the game identity it belongs to. Each node carries the engine's own sha256,
 * so a variable's presence in the graph traces back to a specific Emuera build
 * rather than to an assumption about Era in general.
 */

/** GameBase.csv keys, which are `key,value` rather than `index,name`. */
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

export class EraEngineExtractor {
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
      const fileNodeId = this.createFileNode();
      this.emitGameIdentity(fileNodeId);
      this.emitBuiltinVariables(fileNodeId);
    } catch (error) {
      this.errors.push({
        message: `Era engine extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  private createFileNode(): string {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    this.nodes.push({
      id,
      kind: 'file',
      name: this.filePath.replace(/\\/g, '/').split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'eracsv',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    return id;
  }

  /** GameBase rows are `key,value`; keep them so the graph states which game it holds. */
  private emitGameIdentity(fileNodeId: string): void {
    const now = Date.now();
    for (const line of prepareLines(this.source)) {
      if (line.blank) continue;
      const comma = line.code.indexOf(',');
      if (comma < 0) continue;
      const key = line.code.slice(0, comma).trim();
      const value = line.code.slice(comma + 1).trim();
      if (!key || !GAMEBASE_KEYS.has(key)) continue;
      const qualifiedName = `ERA::GAME::${key}`;
      const id = generateNodeId(this.filePath, 'constant', qualifiedName, line.line);
      this.nodes.push({
        id,
        kind: 'constant',
        name: key,
        qualifiedName,
        filePath: this.filePath,
        language: 'eracsv',
        startLine: line.line,
        endLine: line.line,
        startColumn: 0,
        endColumn: line.code.length,
        signature: `${key} = ${value}`,
        updatedAt: now,
      });
      this.edges.push({ source: fileNodeId, target: id, kind: 'contains' });
    }
  }

  private emitBuiltinVariables(fileNodeId: string): void {
    const now = Date.now();
    const { profile } = this.index;
    for (const variable of profile.variables) {
      const qualifiedName = qualifyVariable(variable.name);
      const id = generateNodeId(this.filePath, 'variable', qualifiedName, 1);
      const traits = [
        variable.valueType,
        variable.dimensions ? `${variable.dimensions}d` : 'scalar',
        variable.perCharacter ? 'per-character' : 'global',
        variable.scope,
      ];
      if (variable.readOnly) traits.push('read-only');
      if (variable.backingCsv) traits.push(`csv:${variable.backingCsv}`);

      this.nodes.push({
        id,
        kind: 'variable',
        name: variable.name,
        qualifiedName,
        filePath: this.filePath,
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
      this.edges.push({ source: fileNodeId, target: id, kind: 'contains' });
    }
  }
}
