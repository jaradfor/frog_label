import { describe, expect, it } from 'vitest';
import {
  createSpeciesPrefixIndex,
  emptySpeciesPrefixSelection,
  isValidLeftHandSpeciesCode,
  type SpeciesPrefixEntry,
} from '../../src/app/speciesPrefix';

interface TestSpecies extends SpeciesPrefixEntry {
  name: string;
}

const species: readonly TestSpecies[] = [
  { speciesId: 'green', code: 'GRE', selectionPriority: 100, name: 'Green tree frog' },
  { speciesId: 'gray', code: 'GRA', selectionPriority: 10, name: 'Gray tree frog' },
  { speciesId: 'g', code: 'G', selectionPriority: 0, name: 'G frog' },
  { speciesId: 'red-long', code: 'RED', selectionPriority: 20, name: 'Red frog' },
  { speciesId: 'red-short', code: 'RE', selectionPriority: 20, name: 'Re frog' },
  { speciesId: 'red-tie-a', code: 'RET', selectionPriority: 20, name: 'Ret A' },
  { speciesId: 'red-tie-b', code: 'RET', selectionPriority: 20, name: 'Ret B' },
];

describe('species prefix index', () => {
  it('promotes exact codes ahead of prefix candidates', () => {
    const resolution = createSpeciesPrefixIndex(species).resolve('g');
    expect(resolution?.winner.speciesId).toBe('g');
    expect(resolution?.exact).toBe(true);
    expect(resolution?.unique).toBe(false);
  });

  it('uses priority before code length for ambiguous prefixes', () => {
    const withoutExact = species.filter((entry) => entry.speciesId !== 'g');
    const resolution = createSpeciesPrefixIndex(withoutExact).resolve('G');
    expect(resolution?.winner.speciesId).toBe('green');
    expect(resolution?.candidates.map((entry) => entry.speciesId)).toEqual(['green', 'gray']);
  });

  it('uses shorter code, lexical code, and species id as deterministic ties', () => {
    const resolution = createSpeciesPrefixIndex(species).resolve('R');
    expect(resolution?.candidates.map((entry) => entry.speciesId)).toEqual([
      'red-short',
      'red-long',
      'red-tie-a',
      'red-tie-b',
    ]);
  });

  it('reports a unique prefix without ending capture', () => {
    const resolution = createSpeciesPrefixIndex(species).resolve('GRa');
    expect(resolution?.winner.speciesId).toBe('gray');
    expect(resolution?.unique).toBe(true);
    expect(resolution?.query).toBe('GRA');
  });

  it('retains the last valid state after an invalid continuation by default', () => {
    const index = createSpeciesPrefixIndex(species);
    const first = index.advance(emptySpeciesPrefixSelection<TestSpecies>(), 'G');
    const second = index.advance(first.state, 'Z');

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.attemptedQuery).toBe('GZ');
    expect(second.state).toBe(first.state);
    expect(second.state.resolution?.winner.speciesId).toBe('g');
  });

  it('can retain an invalid attempted query while clearing its winner', () => {
    const index = createSpeciesPrefixIndex(species);
    const first = index.advance(emptySpeciesPrefixSelection<TestSpecies>(), 'G');
    const second = index.advance(first.state, 'Z', { retainOnInvalid: false });

    expect(second.state.query).toBe('GZ');
    expect(second.state.resolution).toBeNull();
  });

  it('returns no candidate for empty, invalid, or right-side prefixes', () => {
    const index = createSpeciesPrefixIndex(species);
    expect(index.resolve('')).toBeNull();
    expect(index.resolve('Z')).toBeNull();
    expect(index.resolve('H')).toBeNull();
  });

  it('validates administrative codes and priorities once at index construction', () => {
    expect(isValidLeftHandSpeciesCode('QWERTB')).toBe(true);
    expect(isValidLeftHandSpeciesCode('QWERTYB')).toBe(false);
    expect(isValidLeftHandSpeciesCode('PER')).toBe(false);
    expect(() =>
      createSpeciesPrefixIndex([{ speciesId: 'bad', code: 'PER', selectionPriority: 0 }]),
    ).toThrow(/invalid left-hand selection code/);
    expect(() =>
      createSpeciesPrefixIndex([{ speciesId: 'bad', code: 'GRE', selectionPriority: 0.5 }]),
    ).toThrow(/non-integer selection priority/);
  });
});
