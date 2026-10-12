/**
 * Era (Emuera) has three linked layers, not three unrelated file formats:
 * ERB/ERH declares global functions and accesses shared variables; ontology CSV
 * rows name those variables' numeric slots, while Chara CSV rows initialize them;
 * the engine profile supplies built-ins, instruction semantics and CSV mappings.
 * Extraction retains raw index chains; resolution binds named and numeric access
 * to the same ERA::SLOT constant, falling back to a variable for unnamed slots.
 * Interpolated calls are candidate sets, never proof of a runtime call.
 *
 * Upstream seams (the authoritative list; imports outside this module use here):
 * 1. types.ts appends erabasic/eracsv and reads/writes literal kinds.
 * 2. extraction/kernel/loader.ts accepts a prefix edge table, exact node table.
 * 3. extraction/grammars.ts delegates Era recognition/support/display names.
 * 4. extraction/tree-sitter.ts dispatches grammarless Era extraction.
 * 5. file-limits.ts applies Era limits by project-relative path; extraction/index,
 *    mcp/tools, mcp/answer-freshness and resolution/index pass that path.
 * 6. resolution/frameworks/index.ts appends eraResolver.
 * 7. resolution/callback-synthesizer.ts appends eraDispatchPass and its input gate.
 * 8. graph/traversal, context/index, context/formatter and mcp/tools include
 *    reads/writes in usage, recovery and significance sets (not control flow).
 * 9. db/queries.ts appends the unresolved-reference prefix query if needed.
 * 10. extraction/extraction-version.ts is upstream + 1.
 * 11. AGENTS.md carries only the fork synchronization/deployment rules.
 * 12. upgrade/update-check.ts and upgrade/index.ts: a deployed fork build
 *     never checks for, nor installs, an upstream release (isEraBuild).
 */
import * as path from 'path';
import type { Language } from '../types';
import { CodeGraphPackageVersion } from '../mcp/version';
import { isEraCharaCsv, isEraOntologyCsv } from './profile';

/**
 * True for an install made by scripts/era/deploy.ps1, which stamps the version
 * `<upstream>-era.<sha>`. Such an install must never be replaced by an upstream
 * release: that would silently drop the Era adapter.
 */
export function isEraBuild(): boolean {
  return CodeGraphPackageVersion.includes('-era.');
}

export { extractEraBasic } from './erb';
export { extractEraCsv } from './csv';
export { eraResolver, resetEraResolverCaches } from './resolver';
export { eraDispatchPass } from './dispatch';
export * from './profile';
export * from './names';

/** Paths supplied by indexing are relative; absolute callers must supply root. */
function relativeSource(filePath: string, rootDir?: string): string {
  return (rootDir && path.isAbsolute(filePath) ? path.relative(rootDir, filePath) : filePath)
    .replace(/\\/g, '/');
}

export function isEraScriptFile(filePath: string, rootDir?: string): boolean {
  return /^erb\/.*\.(?:erb|erh)$/i.test(relativeSource(filePath, rootDir));
}

export function isEraSourceFile(filePath: string, rootDir?: string): boolean {
  const relative = relativeSource(filePath, rootDir);
  return isEraScriptFile(relative) || isEraCharaCsv(relative) || isEraOntologyCsv(relative);
}

export function detectEraLanguage(filePath: string, source?: string, rootDir?: string): Language | undefined {
  const relative = relativeSource(filePath, rootDir);
  if (isEraCharaCsv(relative) || isEraOntologyCsv(relative)) return 'eracsv';
  if (!isEraScriptFile(relative)) return undefined;
  if (source !== undefined) {
    const head = source.slice(0, 32768);
    const marked = /^[ \t]*(?:@[^\s(;]|\$[^\s;]|#(?:DIM|DIMS|FUNCTION|FUNCTIONS|LOCALSIZE|LOCALSSIZE|INCLUDE|PRI|LATER|SINGLE|ONLY)\b)/m.test(head);
    if (!marked && head.includes('<%')) return undefined;
  }
  return 'erabasic';
}

export function isEraLanguage(language: Language): boolean {
  return language === 'erabasic' || language === 'eracsv';
}

/** Only scripts loaded from the game's top-level ERB tree get the larger limit. */
export function eraSourceSizeLimit(filePath: string): number | undefined {
  return isEraScriptFile(filePath) ? 16 * 1024 * 1024 : undefined;
}
