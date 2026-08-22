import type { FrogLabelDocumentV1, SpeciesCatalogV1, SpeciesEntryV1 } from './types';
import {
  assertCatalog,
  assertDocument,
  normalizeSpeciesCode,
  normalizeSpeciesName,
} from './validation';
import { ValidationError } from './errors';

type LegacySpecies = Partial<SpeciesEntryV1> & { commonName?: string; fullName?: string };

export function migrateSpecies(value: unknown): SpeciesEntryV1 {
  if (!value || typeof value !== 'object')
    throw new ValidationError('Species value must be an object');
  const legacy = value as LegacySpecies;
  if (legacy.schemaVersion !== 1 && legacy.schemaVersion !== undefined) {
    throw new ValidationError(
      'Species was created by a newer FrogLabel',
      String(legacy.schemaVersion),
    );
  }
  const speciesName = normalizeSpeciesName(
    String(legacy.speciesName ?? legacy.commonName ?? legacy.fullName ?? ''),
  );
  const migrated: SpeciesEntryV1 = {
    ...(legacy as SpeciesEntryV1),
    schemaVersion: 1,
    kind: 'froglabel.species',
    code: normalizeSpeciesCode(String(legacy.code ?? '')),
    speciesName,
  };
  delete (migrated as SpeciesEntryV1 & { commonName?: string }).commonName;
  delete (migrated as SpeciesEntryV1 & { fullName?: string }).fullName;
  delete (migrated as SpeciesEntryV1 & { active?: boolean }).active;
  delete (migrated as SpeciesEntryV1 & { replacementSpeciesId?: string }).replacementSpeciesId;
  assertCatalog({
    schemaVersion: 1,
    kind: 'froglabel.species-catalog',
    catalogId: 'migration-check',
    initializedAt: new Date(0).toISOString(),
    initializedBy: 'migration',
    catalogRevision: 1,
    defaultSpeciesId: migrated.speciesId,
    species: [migrated],
  });
  return migrated;
}

export function migrateCatalog(value: unknown): SpeciesCatalogV1 {
  if (!value || typeof value !== 'object') throw new ValidationError('Catalog must be an object');
  const source = value as Partial<SpeciesCatalogV1>;
  if (source.schemaVersion !== 1) {
    throw new ValidationError(
      'Catalog was created by a newer FrogLabel',
      String(source.schemaVersion),
    );
  }
  const migrated = {
    ...source,
    catalogRevision: source.catalogRevision ?? 1,
    species: (source.species ?? []).map(migrateSpecies),
  } as SpeciesCatalogV1;
  assertCatalog(migrated);
  return migrated;
}

export function migrateDocument(value: unknown): FrogLabelDocumentV1 {
  if (!value || typeof value !== 'object') throw new ValidationError('Document must be an object');
  const source = value as Partial<FrogLabelDocumentV1>;
  if (source.schemaVersion !== 1) {
    throw new ValidationError(
      'Document was created by a newer FrogLabel',
      String(source.schemaVersion),
    );
  }
  const migrated = structuredClone(value) as FrogLabelDocumentV1;
  for (const box of migrated.boxes ?? []) {
    if (box.provenance?.source === 'model' && box.provenance.humanModified === undefined) {
      box.provenance.humanModified = false;
    }
  }
  assertDocument(migrated);
  return migrated;
}
