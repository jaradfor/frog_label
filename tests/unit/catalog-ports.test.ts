import { describe, expect, it, vi } from 'vitest';
import { EmbeddedCatalogPort } from '../../src/adapters/enterprise/EmbeddedCatalogPort';
import { LabelStudioSpeciesCatalogPort } from '../../src/adapters/labelStudioCatalog/LabelStudioSpeciesCatalogPort';
import { MemoryAnnotationDocumentPort } from '../../src/adapters/memory/MemoryAnnotationDocumentPort';
import { speciesSnapshot } from '../../src/domain/validation';
import type { FrogLabelDocument, SpeciesEntry } from '../../src/domain/types';
import { catalog, document } from '../fixtures';

const annotationSpecies: SpeciesEntry = {
  schemaVersion: 2,
  kind: 'froglabel.species',
  speciesId: 'local:priority-frog',
  code: 'GTA',
  selectionPriority: 100,
  speciesName: 'Greater Test Amphibian',
  addedAfterInitialization: true,
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
};

describe('Enterprise annotation-scoped catalog', () => {
  it('restores an added species priority from a persisted V2 annotation snapshot', async () => {
    const persisted: FrogLabelDocument = {
      ...structuredClone(document),
      boxes: [
        {
          ...structuredClone(document.boxes[0]),
          species: speciesSnapshot(annotationSpecies),
        },
      ],
    };
    const annotation = new MemoryAnnotationDocumentPort(persisted);
    const port = new EmbeddedCatalogPort(catalog, annotation);

    await expect(port.read()).resolves.toMatchObject({
      species: expect.arrayContaining([
        expect.objectContaining({ speciesId: annotationSpecies.speciesId, selectionPriority: 100 }),
      ]),
    });
    await expect(
      port.create({
        code: 'GTA',
        selectionPriority: 99,
        speciesName: annotationSpecies.speciesName,
      }),
    ).rejects.toThrow(/already uses selection priority 100/u);

    port.destroy();
    annotation.destroy();
  });

  it('continues to read older V2 snapshots that predate persisted priority', async () => {
    const annotation = new MemoryAnnotationDocumentPort({
      ...structuredClone(document),
      boxes: [
        {
          ...structuredClone(document.boxes[0]),
          species: {
            speciesId: annotationSpecies.speciesId,
            code: annotationSpecies.code,
            speciesName: annotationSpecies.speciesName,
            addedAfterInitialization: true,
          },
        },
      ],
    });
    const port = new EmbeddedCatalogPort(catalog, annotation);

    await expect(port.read()).resolves.toMatchObject({
      species: expect.arrayContaining([
        expect.objectContaining({ speciesId: annotationSpecies.speciesId, selectionPriority: 0 }),
      ]),
    });

    port.destroy();
    annotation.destroy();
  });
});

describe('CE catalog create reconciliation', () => {
  it('rejects an idempotent code/name match with a different requested priority', async () => {
    const fetcher = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ catalog, permissions: { createSpecies: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ) as unknown as typeof fetch;
    const port = new LabelStudioSpeciesCatalogPort(7, fetcher);

    await expect(
      port.create({ code: 'ETF', selectionPriority: 42, speciesName: "Peron's Tree Frog" }),
    ).rejects.toMatchObject({ code: 'CATALOG_CODE_CONFLICT' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    port.destroy();
  });
});
