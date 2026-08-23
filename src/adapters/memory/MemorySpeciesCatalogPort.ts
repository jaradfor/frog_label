import type { CreateSpeciesInput, SpeciesCatalogPort } from '../../ports/SpeciesCatalogPort';
import type { SpeciesCatalog, SpeciesEntry } from '../../domain/types';
import { assertCatalog, normalizeSpeciesCode, normalizeSpeciesName } from '../../domain/validation';
import { ValidationError } from '../../domain/errors';

export class MemorySpeciesCatalogPort implements SpeciesCatalogPort {
  private catalog: SpeciesCatalog;
  private destroyed = false;

  constructor(
    catalog: SpeciesCatalog,
    private readonly writable = true,
  ) {
    assertCatalog(catalog);
    this.catalog = structuredClone(catalog);
  }

  async read(): Promise<SpeciesCatalog> {
    this.ensureAlive();
    return structuredClone(this.catalog);
  }

  async create(input: CreateSpeciesInput): Promise<SpeciesEntry> {
    this.ensureAlive();
    if (!this.writable) throw new ValidationError('This catalog is read-only');
    const code = normalizeSpeciesCode(input.code);
    const speciesName = normalizeSpeciesName(input.speciesName);
    const scientificName = input.scientificName
      ? normalizeSpeciesName(input.scientificName)
      : undefined;
    if (!/^[QWERTASDFGZXCVB]{1,6}$/u.test(code)) {
      throw new ValidationError('Code must contain 1–6 left-hand letters');
    }
    if (!speciesName) throw new ValidationError('Full Species Name is required');
    if (
      [...this.catalog.species, ...(this.catalog.historicalSpecies ?? [])].some(
        (entry) => entry.code.toLocaleLowerCase('en') === code.toLocaleLowerCase('en'),
      )
    ) {
      throw new ValidationError(`Code ${code} already exists`);
    }
    const now = new Date().toISOString();
    const entry: SpeciesEntry = {
      schemaVersion: 2,
      kind: 'froglabel.species',
      speciesId: `local:${crypto.randomUUID()}`,
      code,
      selectionPriority: input.selectionPriority ?? 0,
      speciesName,
      ...(scientificName ? { scientificName } : {}),
      addedAfterInitialization: true,
      createdAt: now,
      updatedAt: now,
    };
    const next = {
      ...this.catalog,
      catalogRevision: this.catalog.catalogRevision + 1,
      species: [...this.catalog.species, entry],
    };
    assertCatalog(next);
    this.catalog = next;
    return structuredClone(entry);
  }

  canCreate(): boolean {
    return this.writable;
  }

  destroy(): void {
    this.destroyed = true;
  }

  private ensureAlive(): void {
    if (this.destroyed) throw new Error('Catalog port has been destroyed.');
  }
}
