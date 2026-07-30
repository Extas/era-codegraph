import * as fs from 'fs';
import * as path from 'path';
import { EraEngineProfile, EraProfileIndex, EraVariable } from './types';

/**
 * Engine profile loading.
 *
 * Callers ask for `getEraProfile()` and get a fully indexed profile or a clear
 * throw; there is no "profile missing" state to handle at every call site. The
 * shipped default is the engine era-ym actually runs (Emuera 1.824 EEv55); a
 * project on a different build points `CODEGRAPH_ERA_PROFILE` at either a
 * shipped profile id or an absolute path to a generated one.
 */

const DEFAULT_PROFILE_ID = 'emuera-1824-ee55';

/** `chara*.csv` is per-character instance data, not ontology — never indexed. */
const NON_ONTOLOGY_CSV = /\*/;

let cached: EraProfileIndex | null = null;

/** Directory holding shipped profiles, in both source and built layouts. */
function profilesDir(): string {
  return path.join(__dirname, 'profiles');
}

function resolveProfilePath(): string {
  const requested = process.env.CODEGRAPH_ERA_PROFILE?.trim();
  if (requested) {
    if (requested.endsWith('.json')) return requested;
    return path.join(profilesDir(), `${requested}.json`);
  }
  return path.join(profilesDir(), `${DEFAULT_PROFILE_ID}.json`);
}

/** Load and index the active engine profile. Cached for the process. */
export function getEraProfile(): EraProfileIndex {
  if (cached) return cached;
  const file = resolveProfilePath();
  let profile: EraEngineProfile;
  try {
    profile = JSON.parse(fs.readFileSync(file, 'utf8')) as EraEngineProfile;
  } catch (error) {
    throw new Error(
      `Era engine profile could not be read from ${file}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (profile.schemaVersion !== 1) {
    throw new Error(`Era engine profile ${file} has unsupported schemaVersion ${profile.schemaVersion}`);
  }
  cached = indexProfile(profile);
  return cached;
}

/** Reset the cache. Tests use this to swap profiles; production never calls it. */
export function resetEraProfileCache(): void {
  cached = null;
}

/** Build the lookup maps every extractor and the resolver share. */
export function indexProfile(profile: EraEngineProfile): EraProfileIndex {
  const variables = new Map<string, EraVariable>();
  for (const v of profile.variables) variables.set(v.name, v);

  const instructions = new Map(profile.instructions.map((i) => [i.name, i]));
  const methods = new Set(profile.methods ?? []);

  const csvToVariables = new Map<string, EraVariable[]>();
  for (const v of profile.variables) {
    if (!v.backingCsv || NON_ONTOLOGY_CSV.test(v.backingCsv)) continue;
    const key = v.backingCsv.toLowerCase();
    const list = csvToVariables.get(key);
    if (list) list.push(v);
    else csvToVariables.set(key, [v]);
  }

  // Every CSV the engine loads is ontology, including ones no variable names
  // through (STRNAME.CSV names STR); indexing them all keeps `who defines this
  // row` answerable even where the naming path is indirect.
  const ontologyCsvNames = new Set<string>();
  for (const f of profile.csvFiles) ontologyCsvNames.add(f.toLowerCase());
  for (const key of csvToVariables.keys()) ontologyCsvNames.add(key);

  return { profile, variables, instructions, methods, csvToVariables, ontologyCsvNames };
}

/**
 * Is this path one of the ontology CSVs the engine loads?
 *
 * Matching is by basename, case-insensitively: the engine looks in a single
 * `csvDir`, and games spell the files inconsistently (`Abl.csv` on disk,
 * `ABL.CSV` in the engine). The path must be exactly `CSV/<name>` at the
 * project root, which is where Emuera looks and nowhere else. A looser rule
 * would claim an unrelated `Item.csv` in another project, and would also pull
 * in the tables that ship inside a game's optional patch directories, which
 * the engine never loads.
 */
export function isEraOntologyCsv(filePath: string, index?: EraProfileIndex): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.indexOf('/');
  if (slash < 0 || normalized.slice(0, slash).toLowerCase() !== 'csv') return false;
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (normalized.indexOf('/', slash + 1) >= 0) return false; // no nesting under CSV/
  if (!base.toLowerCase().endsWith('.csv')) return false;
  const lower = base.toLowerCase();
  // GameBase.csv is not an ontology table, but it is where the engine
  // vocabulary is anchored, so it has to be indexed too.
  if (lower === 'gamebase.csv') return true;
  let profileIndex: EraProfileIndex;
  try {
    profileIndex = index ?? getEraProfile();
  } catch {
    return false;
  }
  return profileIndex.ontologyCsvNames.has(lower);
}
