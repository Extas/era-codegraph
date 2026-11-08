import { Node } from '../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../resolution/types';
import { getEraProfile } from './profile';
import { EraProfileIndex } from './profile';
import {
  isEraReference,
  parseVariableRef,
  qualifySlot,
  qualifyVariable,
} from './names';

/**
 * The C# / ERB / CSV cross-layer resolver.
 *
 * Extraction sees one file at a time, so an ERB line like `SIF ABL:顺从 < 1`
 * can only be recorded verbatim. Turning it into an edge needs all three
 * layers at once: the engine profile (derived from Emuera's own C#) says ABL is
 * named through Abl.csv, the CSV side of the graph says row 10 of that file is
 * 顺从, and only then does the reference point at a symbol.
 *
 * Numeric indices are resolved the same way, and a numeric index with no CSV
 * row is not a failure: `TFLAG:899` in a game that ships no Tflag.csv is an
 * unnamed slot, which is a real and reportable answer. It binds to the variable
 * so the access still shows up in that variable's consumers.
 *
 * Interpolated call sites (`TRYCALLFORM COM_ABLE{com_id}`) are NOT resolved
 * here. One reference maps to many candidate functions and a ResolvedRef can
 * only name one target, so the fan-out is synthesized separately; see
 * `./dispatch`.
 */

/** Index tokens that name a character rather than a slot. */
const CHARACTER_SELECTORS: Record<string, true> = {
  MASTER: true, TARGET: true, PLAYER: true, ASSI: true,
  ASSIPLAY: true, NO: true, CHARANUM: true,
};


/**
 * Slot dictionaries, built once per resolution run.
 *
 * The CSV nodes are already in the graph under `ERA::SLOT::<VAR>:<index>`, so
 * a numeric index needs no dictionary at all. Named indices do: the map from
 * `顺从` to 10 exists only as the CSV row's name, and one lookup table per
 * variable turns every later reference into a hash hit.
 */
interface SlotIndex {
  /** primary variable -> (row name -> slot index) */
  byVariable: Map<string, Map<string, number>>;
  bySlot: Map<string, Node>;
  profile: EraProfileIndex;
}

const slotIndexes = new WeakMap<ResolutionContext, { source: Node[]; index: SlotIndex }>();

function slotsFor(context: ResolutionContext): SlotIndex {
  // ReferenceResolver replaces its kind arrays when it clears a resolution pass.
  const source = context.getNodesByKind('constant');
  const cached = slotIndexes.get(context);
  if (cached?.source === source) return cached.index;
  const index = buildSlotIndex(source);
  slotIndexes.set(context, { source, index });
  return index;
}

function buildSlotIndex(constants: Node[]): SlotIndex {
  const byVariable = new Map<string, Map<string, number>>();
  const bySlot = new Map<string, Node>();
  // ConstantData.loadDataTo overwrites numeric rows; preserve all graph nodes,
  // but resolve the final line. Its reverse dictionary then visits slots in
  // ascending numeric order, so a duplicate name means the lowest final slot.
  for (const node of constants) {
    if (node.language !== 'eracsv') continue;
    const parsed = parseSlotQualifiedName(node.qualifiedName);
    if (!parsed) continue;
    const previous = bySlot.get(node.qualifiedName);
    if (!previous || previous.startLine < node.startLine) bySlot.set(node.qualifiedName, node);
  }
  for (const node of bySlot.values()) {
    const parsed = parseSlotQualifiedName(node.qualifiedName)!;
    let names = byVariable.get(parsed.variable);
    if (!names) byVariable.set(parsed.variable, (names = new Map()));
    if (!node.decorators?.includes('era:empty-slot-name') && node.name &&
        (!names.has(node.name) || names.get(node.name)! > parsed.index)) names.set(node.name, parsed.index);
  }
  return { byVariable, bySlot, profile: getEraProfile() };
}

function parseSlotQualifiedName(qualifiedName: string): { variable: string; index: number } | null {
  if (!qualifiedName.startsWith('ERA::SLOT::')) return null;
  const rest = qualifiedName.slice('ERA::SLOT::'.length);
  const colon = rest.lastIndexOf(':');
  if (colon < 0) return null;
  const index = Number.parseInt(rest.slice(colon + 1), 10);
  if (!Number.isInteger(index)) return null;
  return { variable: rest.slice(0, colon), index };
}

/**
 * The variable a slot is filed under. Several variables share one CSV
 * (ITEM/ITEMSALES/ITEMPRICE all read Item.csv), and the CSV extractor files
 * each row once, under the variable named after the file when there is one.
 */
function primaryVariableFor(name: string, index: EraProfileIndex): string {
  const variable = index.variables.get(name);
  if (!variable?.backingCsv || variable.backingCsv.includes('*')) return name;
  const binders = index.csvToVariables.get(variable.backingCsv.toLowerCase()) ?? [];
  const stem = variable.backingCsv.replace(/\.[^.]*$/, '').toUpperCase();
  const exact = binders.find((v) => v.name === stem);
  if (exact) return exact.name;
  if (binders.length) return [...binders].sort((a, b) => a.name.localeCompare(b.name))[0]!.name;
  return name;
}

function firstNode(nodes: Node[]): Node | undefined {
  return nodes.length ? nodes[0] : undefined;
}

function resolved(ref: UnresolvedRef, target: Node, confidence: number): ResolvedRef {
  return { original: ref, targetNodeId: target.id, confidence, resolvedBy: 'framework' };
}

export const eraResolver: FrameworkResolver = {
  name: 'era',
  languages: ['erabasic', 'eracsv'],

  /**
   * An Era game is recognised by its layout, not by a manifest: an `ERB`
   * directory of scripts beside a `CSV` directory of ontology tables. Checking
   * the indexed file list keeps detection independent of where the game is
   * mounted.
   */
  detect(context: ResolutionContext): boolean {
    getEraProfile();
    let sawScript = false;
    for (const file of context.getAllFiles()) {
      const lower = file.toLowerCase();
      if (lower.endsWith('.erb') || lower.endsWith('.erh')) {
        sawScript = true;
        break;
      }
    }
    return sawScript;
  },

  /**
   * Era reference names are synthetic (`ERA::REF::ABL:顺从`) and match no
   * symbol name, so the generic name-existence pre-filter would drop every one
   * of them before this resolver ever saw it.
   */
  claimsReference(name: string): boolean {
    return isEraReference(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const index = slotsFor(context).profile;

    if (ref.referenceName.startsWith('ERA::FN::')) {
      const target = firstNode(context.getNodesByQualifiedName(ref.referenceName));
      return target ? resolved(ref, target, 0.95) : null;
    }

    // Interpolated call sites fan out to many targets; era-dispatch owns them.
    if (ref.referenceName.startsWith('ERA::DYN::')) return null;

    const variableRef = parseVariableRef(ref.referenceName);
    if (!variableRef) return null;
    return resolveVariable(ref, variableRef, context, index);
  },
};

function resolveVariable(
  ref: UnresolvedRef,
  parsed: { variable: string; indices: string[] },
  context: ResolutionContext,
  index: EraProfileIndex
): ResolvedRef | null {
  const { variable, indices } = parsed;
  const builtin = index.variables.get(variable);

  // A game-declared global (`#DIM SAVEDATA custom_talent`) is an ordinary node.
  if (!builtin) {
    const target = firstNode(context.getNodesByQualifiedName(qualifyVariable(variable)));
    return target ? resolved(ref, target, 0.9) : null;
  }

  const primary = primaryVariableFor(variable, index);

  if (indices.length && builtin.backingCsv && !builtin.backingCsv.includes('*')) {
    const slots = slotsFor(context);
    const names = slots.byVariable.get(primary);

    for (const token of indices) {
      // `ABL:MASTER:顺从` selects a character first; only the remaining token
      // can be a slot name.
      if (Object.hasOwn(CHARACTER_SELECTORS, token) || index.variables.has(token)) continue;
      if (token.startsWith('(')) continue;

      const numeric = /^\d+$/.test(token) ? Number.parseInt(token, 10) : names?.get(token);
      if (numeric === undefined) continue;
      const slot = slots.bySlot.get(qualifySlot(primary, numeric));
      if (slot) return resolved(ref, slot, /^\d+$/.test(token) ? 0.85 : 0.95);
    }
  }

  // No slot matched: an unnamed index, an expression index, or a variable the
  // game indexes by number only. The access still belongs to the variable, and
  // saying so is more useful than dropping the edge.
  const target = firstNode(context.getNodesByQualifiedName(qualifyVariable(variable)));
  return target ? resolved(ref, target, 0.7) : null;
}


