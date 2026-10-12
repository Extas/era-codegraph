import type { Edge, Node } from '../types';
import type { SynthPassDef } from '../resolution/callback-synthesizer';
import { DYNAMIC_CALL_PREFIX, parseDynamicCallRef } from './names';

/**
 * Interpolated calls name a family of functions, not one resolvable symbol.
 * Prefer numeric holes (COM_ABLE{n}); only use arbitrary names when no numeric
 * target exists, under a smaller cap. All edges remain explicit heuristics.
 * References are retained, including failed rows, so an unchanged dispatcher
 * can acquire candidates added by a later sync. Persistence belongs to the
 * synthesis coordinator, never this pass.
 */
const MAX_CANDIDATES_PER_SITE = 512;
const MAX_LOOSE_CANDIDATES = 64;

export const eraDispatchPass: SynthPassDef = {
  name: 'era-dispatch',
  gate: (has) => has('erabasic'),
  async run(queries, _context, yieldToLoop): Promise<Edge[]> {
    const refs = queries.getUnresolvedReferencesByNamePrefix(DYNAMIC_CALL_PREFIX);
    if (!refs.length) return [];

    const functions: Node[] = [];
    let scanned = 0;
    for (const node of queries.iterateNodesByKindIn('function', ['erabasic'])) {
      functions.push(node);
      if ((++scanned & 255) === 0) await yieldToLoop();
    }
    if (!functions.length) return [];

    const byPattern = new Map<string, Node[]>();
    const edges: Edge[] = [];
    for (const ref of refs) {
      if ((++scanned & 255) === 0) await yieldToLoop();
      const parsed = parseDynamicCallRef(ref.referenceName);
      if (!parsed) continue;
      const key = `${parsed.prefix}|${parsed.suffix}`;
      let candidates = byPattern.get(key);
      if (!candidates) {
        candidates = matchCandidates(functions, parsed.prefix, parsed.suffix);
        byPattern.set(key, candidates);
      }
      if (candidates.length > MAX_CANDIDATES_PER_SITE) continue;
      for (const target of candidates) {
        edges.push({
          source: ref.fromNodeId,
          target: target.id,
          kind: 'calls',
          line: ref.line,
          column: ref.column,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'era-dispatch',
            prefix: parsed.prefix,
            suffix: parsed.suffix,
            candidates: candidates.length,
          },
        });
      }
    }
    return edges;
  },
};

function matchCandidates(functions: Node[], prefix: string, suffix: string): Node[] {
  const minLength = prefix.length + suffix.length;
  const numeric: Node[] = [];
  const loose: Node[] = [];
  for (const fn of functions) {
    const name = fn.name;
    if (name.length <= minLength || !name.startsWith(prefix)) continue;
    if (suffix && !name.endsWith(suffix)) continue;
    const middle = name.slice(prefix.length, name.length - suffix.length);
    if (/^\d+$/.test(middle)) numeric.push(fn);
    else loose.push(fn);
  }
  if (numeric.length) return numeric;
  return loose.length <= MAX_LOOSE_CANDIDATES ? loose : [];
}
