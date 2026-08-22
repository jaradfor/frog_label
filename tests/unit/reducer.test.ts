import { describe, expect, it } from 'vitest';
import { deterministicSerialize } from '../../src/domain/document';
import { domainReducer, initialDomainState } from '../../src/domain/reducer';
import { bounds, catalog, document, per } from '../fixtures';

describe('semantic domain reducer', () => {
  it('selects an existing box without requiring a current species', () => {
    let state = initialDomainState(catalog.catalogId, bounds);
    state = domainReducer(state, {
      type: 'context/replace',
      epoch: 1,
      catalogId: catalog.catalogId,
      bounds,
      document,
    });
    state = domainReducer(state, { type: 'box/select', boxId: 'box:one' });
    expect(state.selectedBoxId).toBe('box:one');
  });

  it('creates one box and one undo transaction per commit', () => {
    let state = initialDomainState(catalog.catalogId, bounds);
    state = domainReducer(state, {
      type: 'box/createCommitted',
      species: per,
      id: 'box:new',
      timestamp: '2026-08-20T00:00:00.000Z',
      geometry: {
        startTimeSeconds: 1,
        endTimeSeconds: 2,
        lowFrequencyHz: 200,
        highFrequencyHz: 800,
      },
    });
    expect(state.document?.boxes).toHaveLength(1);
    expect(state.undo).toHaveLength(1);
    state = domainReducer(state, { type: 'history/undo' });
    expect(state.document).toBeNull();
    state = domainReducer(state, { type: 'history/redo' });
    expect(state.document?.boxes[0].id).toBe('box:new');
  });

  it('deleting the final box removes the singleton instead of inferring no-calls', () => {
    let state = initialDomainState(catalog.catalogId, bounds);
    state = domainReducer(state, {
      type: 'context/replace',
      epoch: 1,
      catalogId: catalog.catalogId,
      bounds,
      document,
    });
    state = domainReducer(state, { type: 'box/delete', boxId: 'box:one' });
    expect(state.document).toBeNull();
    state = domainReducer(state, { type: 'review/setNoCalls' });
    expect(state.document?.reviewStatus).toBe('no_calls');
    expect(state.document?.boxes).toEqual([]);
  });

  it('resets selection, preview, and history at an epoch boundary', () => {
    let state = initialDomainState(catalog.catalogId, bounds);
    state = domainReducer(state, {
      type: 'box/createCommitted',
      species: per,
      id: 'box:new',
      timestamp: '2026-08-20T00:00:00.000Z',
      geometry: {
        startTimeSeconds: 1,
        endTimeSeconds: 2,
        lowFrequencyHz: 200,
        highFrequencyHz: 800,
      },
    });
    state = domainReducer(state, {
      type: 'context/replace',
      epoch: 2,
      catalogId: catalog.catalogId,
      bounds,
      document: null,
    });
    expect(state.epoch).toBe(2);
    expect(state.selectedBoxId).toBeNull();
    expect(state.undo).toEqual([]);
  });

  it('compares semantic documents independently of object key insertion order', () => {
    const reordered = {
      boxes: document.boxes.map((box) => ({
        provenance: box.provenance,
        ...(box.updatedAt ? { updatedAt: box.updatedAt } : {}),
        ...(box.createdAt ? { createdAt: box.createdAt } : {}),
        highFrequencyHz: box.highFrequencyHz,
        lowFrequencyHz: box.lowFrequencyHz,
        endTimeSeconds: box.endTimeSeconds,
        startTimeSeconds: box.startTimeSeconds,
        species: {
          speciesName: box.species.speciesName,
          addedAfterInitialization: box.species.addedAfterInitialization,
          code: box.species.code,
          speciesId: box.species.speciesId,
        },
        id: box.id,
      })),
      reviewStatus: document.reviewStatus,
      catalogId: document.catalogId,
      schemaVersion: document.schemaVersion,
      kind: document.kind,
    };
    expect(deterministicSerialize(reordered)).toBe(deterministicSerialize(document));
  });
});
