/**
 * Qualified-name scheme for the Era layers.
 *
 * ERB has no modules, packages or imports: `@FUNCTION` names and variable names
 * are global and unique across the whole game. So a name alone identifies a
 * symbol, and these prefixes exist only to keep the three layers from colliding
 * with each other and with symbols from other languages in the same index.
 *
 *   ERA::CSV::<file>              an ontology CSV table
 *   ERA::SLOT::<VAR>:<index>      one named row of that table
 *   ERA::VAR::<name>              a built-in or `#DIM`-declared global variable
 *   ERA::FN::<name>               an `@FUNCTION`
 *   ERA::LOCAL::<fn>::<name>      a `#DIM` inside a function
 *   ERA::LABEL::<fn>::<name>      a `$LABEL` inside a function
 *
 * Extraction emits references in two forms, both resolved by the Era resolver:
 *
 *   ERA::REF::<name>[:<idx>…]     a variable access, index chain verbatim
 *   ERA::DYN::<prefix>            a call whose target name is built at run time
 *
 * The index chain stays verbatim because the extractor works one file at a time
 * and cannot know whether `顺从` is an Abl.csv row: that binding needs the CSV
 * side of the graph, which only the resolver has.
 */

export const ERA_PREFIX = 'ERA::';

export const qualifyCsv = (fileName: string): string => `ERA::CSV::${fileName}`;
export const qualifySlot = (variable: string, index: number | string): string =>
  `ERA::SLOT::${variable}:${index}`;
export const qualifyVariable = (name: string): string => `ERA::VAR::${name}`;
export const qualifyFunction = (name: string): string => `ERA::FN::${name}`;
export const qualifyLocal = (fn: string, name: string): string => `ERA::LOCAL::${fn}::${name}`;
export const qualifyLabel = (fn: string, name: string): string => `ERA::LABEL::${fn}::${name}`;

export const refVariable = (chain: string): string => `ERA::REF::${chain}`;

/**
 * A call whose target name is assembled at run time. Both the literal text
 * before the first hole and after the last one are kept (`EVENT_K{no}_A` ->
 * prefix `EVENT_K`, suffix `_A`), because both narrow the candidate set. `|`
 * separates them: it cannot occur in an Era identifier.
 */
export const refDynamicCall = (prefix: string, suffix = ''): string => `ERA::DYN::${prefix}|${suffix}`;

/** Does this reference name belong to the Era resolver? */
export const isEraReference = (name: string): boolean => name.startsWith(ERA_PREFIX);

/**
 * Split `ERA::REF::ABL:MASTER:顺从` into its variable and index tokens.
 * Returns null for anything that is not a variable reference.
 */
export function parseVariableRef(referenceName: string): { variable: string; indices: string[] } | null {
  if (!referenceName.startsWith('ERA::REF::')) return null;
  const chain = referenceName.slice('ERA::REF::'.length);
  if (!chain) return null;
  const parts = chain.split(':');
  return { variable: parts[0]!, indices: parts.slice(1) };
}

/** Recover the literal prefix and suffix from a dynamic-call reference name. */
export function parseDynamicCallRef(referenceName: string): { prefix: string; suffix: string } | null {
  if (!referenceName.startsWith('ERA::DYN::')) return null;
  const rest = referenceName.slice('ERA::DYN::'.length);
  const bar = rest.indexOf('|');
  if (bar < 0) return rest ? { prefix: rest, suffix: '' } : null;
  const prefix = rest.slice(0, bar);
  if (!prefix) return null;
  return { prefix, suffix: rest.slice(bar + 1) };
}

/** Prefix every dynamic-call reference name starts with. */
export const DYNAMIC_CALL_PREFIX = 'ERA::DYN::';
