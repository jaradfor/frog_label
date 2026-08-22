import { describe, expect, it } from 'vitest';
import {
  assertCatalog,
  assertDocument,
  normalizeSpeciesCode,
  normalizeSpeciesName,
} from '../../src/domain/validation';
import { catalog, document } from '../fixtures';

describe('runtime validation', () => {
  it('accepts the canonical catalog and document', () => {
    expect(() => assertCatalog(catalog)).not.toThrow();
    expect(() =>
      assertDocument(document, { durationSeconds: 30, maximumFrequencyHz: 22050 }),
    ).not.toThrow();
  });

  it('normalizes species data rather than relying on CSS', () => {
    expect(normalizeSpeciesCode(' per ')).toBe('PER');
    expect(normalizeSpeciesName('  Peron’s\tTree  Frog ')).toBe('Peron’s Tree Frog');
  });

  it('rejects duplicate case-insensitive current codes', () => {
    const duplicate = structuredClone(catalog);
    duplicate.species.push({ ...duplicate.species[0], speciesId: 'local:two' });
    expect(() => assertCatalog(duplicate)).toThrow(/Duplicate species code/);
  });

  it('rejects nonfinite and inverted geometry', () => {
    const invalid = structuredClone(document);
    invalid.boxes[0].startTimeSeconds = Number.NaN;
    expect(() => assertDocument(invalid)).toThrow();

    const inverted = structuredClone(document);
    inverted.boxes[0].endTimeSeconds = inverted.boxes[0].startTimeSeconds;
    expect(() => assertDocument(inverted)).toThrow();
  });

  it('rejects duplicate stable box IDs', () => {
    const invalid = structuredClone(document);
    invalid.boxes.push(structuredClone(invalid.boxes[0]));
    expect(() => assertDocument(invalid)).toThrow(/Duplicate box ID/);
  });

  it('rejects documents above the 5,000-box POC ceiling before rendering', () => {
    const invalid = structuredClone(document);
    invalid.boxes = Array.from({ length: 5_001 }, (_, index) => ({
      ...structuredClone(document.boxes[0]),
      id: `box:ceiling-${index}`,
    }));
    try {
      assertDocument(invalid);
      expect.unreachable('The over-limit document was accepted');
    } catch (error) {
      expect(error).toMatchObject({
        structured: { detail: expect.stringMatching(/5000|must NOT have more than/u) },
      });
    }
  });
});
