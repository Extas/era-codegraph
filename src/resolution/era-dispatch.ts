import { Edge, Node } from '../types';
import { QueryBuilder } from '../db/queries';
import { ResolutionContext } from './types';
import { DYNAMIC_CALL_PREFIX, parseDynamicCallRef } from '../extraction/era/names';

/**
 * Interpolated call-site fan-out.
 *
 * `TRYCALLFORM COM_ABLE{com_id}` is how an Era game dispatches every training
 * command: the target name is assembled at run time, so no text search connects
 * the dispatcher to `@COM_ABLE103`, and the most basic question a remake asks —
 * "what reaches this behaviour" — has no answer. The engine's own instruction
 * table marks these sites (the `isForm` bit), extraction records the literal
 * text around the hole, and this pass widens that to the functions that could
 * actually be reached.
 *
 * It cannot run through the per-reference resolver: one reference maps to many
 * targets and a ResolvedRef names exactly one. So the edges are written here,
 * after extraction, marked `heuristic` so nothing mistakes them for a direct
 * call, and always carrying the candidate count so a reader can see how wide
 * the guess is.
 */

/** Above this, a site is reported rather than expanded: the guess is too wide to be evidence. */
const MAX_CANDIDATES_PER_SITE = 512;

/** Fallback tier cap; a non-numeric hole is a much weaker signal. */
const MAX_LOOSE_CANDIDATES = 64;

export interface EraDispatchResult {
  sites: number;
  edges: number;
  /** Sites whose candidate set was too wide to expand. */
  skipped: number;
}

export function synthesizeEraDispatchEdges(
  queries: QueryBuilder,
  context: ResolutionContext
): EraDispatchResult {
  const empty: EraDispatchResult = { sites: 0, edges: 0, skipped: 0 };
  const refs = queries.getUnresolvedReferencesByNamePrefix(DYNAMIC_CALL_PREFIX);
  if (refs.length === 0) return empty;

  const functions = collectEraFunctions(context);
  if (functions.length === 0) return empty;

  // Sites repeat the same pattern (eight `COM_ABLE{…}` dispatchers in era-ym),
  // so candidate sets are computed once per pattern, not once per site.
  const byPattern = new Map<string, Node[]>();
  const edges: Edge[] = [];
  let sites = 0;
  let skipped = 0;

  for (const ref of refs) {
    const parsed = parseDynamicCallRef(ref.referenceName);
    if (!parsed) continue;
    const key = `${parsed.prefix} ${parsed.suffix}`;
    let candidates = byPattern.get(key);
    if (!candidates) {
      candidates = matchCandidates(functions, parsed.prefix, parsed.suffix);
      byPattern.set(key, candidates);
    }

    if (candidates.length === 0) continue;
    if (candidates.length > MAX_CANDIDATES_PER_SITE) {
      skipped++;
      continue;
    }

    sites++;
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

  // The references are deliberately NOT consumed. A later sync that adds
  // `@COM_ABLE105` has to reach every dispatcher that could call it, including
  // the ones in files that did not change and so emit no new reference. Keeping
  // the references makes each run re-derive the full fan-out from the current
  // function set; the unique edge index makes the re-insert a no-op for edges
  // that already exist, and a deleted function takes its edges with it through
  // the foreign key cascade.
  if (edges.length) queries.insertEdges(edges);
  return { sites, edges: edges.length, skipped };
}

function collectEraFunctions(context: ResolutionContext): Node[] {
  const out: Node[] = [];
  const source = context.iterateNodesByKind
    ? context.iterateNodesByKind('function')
    : context.getNodesByKind('function');
  for (const node of source) {
    if (node.language === 'erabasic') out.push(node);
  }
  return out;
}

/**
 * Functions a pattern could reach.
 *
 * The strong signal is a numeric hole: `COM_ABLE` + digits is how command
 * dispatch works, and it correctly excludes `COM_ABLE_BATTLE`, which shares the
 * prefix but is an ordinary helper. Only when nothing numeric matches does the
 * loose tier accept any middle, and then under a much smaller cap, because a
 * name-shaped hole is far weaker evidence.
 */
function matchCandidates(functions: Node[], prefix: string, suffix: string): Node[] {
  const minLength = prefix.length + suffix.length;
  const numeric: Node[] = [];
  const loose: Node[] = [];

  for (const fn of functions) {
    const name = fn.name;
    if (name.length <= minLength) continue;
    if (!name.startsWith(prefix)) continue;
    if (suffix && !name.endsWith(suffix)) continue;
    const middle = name.slice(prefix.length, name.length - suffix.length);
    if (!middle) continue;
    if (/^\d+$/.test(middle)) numeric.push(fn);
    else loose.push(fn);
  }

  if (numeric.length) return numeric;
  return loose.length <= MAX_LOOSE_CANDIDATES ? loose : [];
}
