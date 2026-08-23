/** Physical left-side QWERTY characters accepted by the Space species chord. */
export const LEFT_HAND_SPECIES_CHARACTERS = 'QWERTASDFGZXCVB' as const;
export const LEFT_HAND_SPECIES_CODE_PATTERN = /^[QWERTASDFGZXCVB]{1,6}$/;

export interface SpeciesPrefixEntry {
  speciesId: string;
  code: string;
  selectionPriority: number;
}

export interface SpeciesPrefixResolution<Entry extends SpeciesPrefixEntry> {
  query: string;
  winner: Entry;
  /** Candidates in the same deterministic order used to choose `winner`. */
  candidates: readonly Entry[];
  exact: boolean;
  unique: boolean;
}

export interface SpeciesPrefixSelection<Entry extends SpeciesPrefixEntry> {
  query: string;
  resolution: SpeciesPrefixResolution<Entry> | null;
}

export interface SpeciesPrefixAdvance<Entry extends SpeciesPrefixEntry> {
  state: SpeciesPrefixSelection<Entry>;
  accepted: boolean;
  /** The query that was attempted, useful for concise rejected-key feedback. */
  attemptedQuery: string;
}

export interface SpeciesPrefixIndex<Entry extends SpeciesPrefixEntry> {
  entries: readonly Entry[];
  resolve(query: string): SpeciesPrefixResolution<Entry> | null;
  advance(
    state: SpeciesPrefixSelection<Entry>,
    character: string,
    options?: { retainOnInvalid?: boolean },
  ): SpeciesPrefixAdvance<Entry>;
}

/**
 * Build an immutable prefix lookup once per catalog revision. Codes are
 * validated here so a malformed administrative catalog cannot produce a
 * surprising shortcut at runtime.
 */
export function createSpeciesPrefixIndex<Entry extends SpeciesPrefixEntry>(
  entries: readonly Entry[],
): SpeciesPrefixIndex<Entry> {
  const indexedEntries = [...entries];
  const byPrefix = new Map<string, Entry[]>();

  for (const entry of indexedEntries) {
    assertIndexableEntry(entry);
    for (let length = 1; length <= entry.code.length; length += 1) {
      const prefix = entry.code.slice(0, length);
      const candidates = byPrefix.get(prefix);
      if (candidates) candidates.push(entry);
      else byPrefix.set(prefix, [entry]);
    }
  }

  for (const candidates of byPrefix.values()) candidates.sort(compareBaseRank);

  const resolve = (rawQuery: string): SpeciesPrefixResolution<Entry> | null => {
    const query = normalizeSpeciesPrefixQuery(rawQuery);
    if (!query) return null;
    const indexedCandidates = byPrefix.get(query);
    if (!indexedCandidates?.length) return null;

    // Exact code wins even when another entry has a higher administrative
    // priority. The remaining candidates retain their stable base rank.
    const candidates = [...indexedCandidates].sort((left, right) => {
      const exactDifference = Number(right.code === query) - Number(left.code === query);
      return exactDifference || compareBaseRank(left, right);
    });

    return {
      query,
      winner: candidates[0],
      candidates,
      exact: candidates[0].code === query,
      unique: candidates.length === 1,
    };
  };

  return {
    entries: indexedEntries,
    resolve,
    advance(state, character, options = {}) {
      const normalizedCharacter = normalizeSpeciesPrefixQuery(character);
      const attemptedQuery = `${state.query}${normalizedCharacter}`;
      const resolution =
        normalizedCharacter.length === 1 && isLeftHandSpeciesCharacter(normalizedCharacter)
          ? resolve(attemptedQuery)
          : null;
      if (resolution) {
        return {
          state: { query: attemptedQuery, resolution },
          accepted: true,
          attemptedQuery,
        };
      }
      if (options.retainOnInvalid !== false) {
        return { state, accepted: false, attemptedQuery };
      }
      return {
        state: { query: attemptedQuery, resolution: null },
        accepted: false,
        attemptedQuery,
      };
    },
  };
}

export function emptySpeciesPrefixSelection<
  Entry extends SpeciesPrefixEntry,
>(): SpeciesPrefixSelection<Entry> {
  return { query: '', resolution: null };
}

export function isLeftHandSpeciesCharacter(character: string): boolean {
  return character.length === 1 && LEFT_HAND_SPECIES_CHARACTERS.includes(character);
}

export function isValidLeftHandSpeciesCode(code: string): boolean {
  return LEFT_HAND_SPECIES_CODE_PATTERN.test(code);
}

export function normalizeSpeciesPrefixQuery(query: string): string {
  return query.toUpperCase();
}

function compareBaseRank<Entry extends SpeciesPrefixEntry>(left: Entry, right: Entry): number {
  return (
    right.selectionPriority - left.selectionPriority ||
    left.code.length - right.code.length ||
    compareLexically(left.code, right.code) ||
    compareLexically(left.speciesId, right.speciesId)
  );
}

function compareLexically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertIndexableEntry(entry: SpeciesPrefixEntry): void {
  if (!entry.speciesId) throw new Error('Species prefix entries require a speciesId');
  if (!isValidLeftHandSpeciesCode(entry.code)) {
    throw new Error(
      `Species ${entry.speciesId} has invalid left-hand selection code ${JSON.stringify(entry.code)}`,
    );
  }
  if (!Number.isSafeInteger(entry.selectionPriority)) {
    throw new Error(`Species ${entry.speciesId} has a non-integer selection priority`);
  }
}
