import { ValidationError } from '../../domain/errors';
import type { SpeciesCatalogV1, SpeciesEntryV1, SpeciesSnapshotV1 } from '../../domain/types';
import { assertCatalog, normalizeSpeciesCode, normalizeSpeciesName } from '../../domain/validation';
import type { AnnotationDocumentPort } from '../../ports/AnnotationDocumentPort';
import type { CreateSpeciesInput, SpeciesCatalogPort } from '../../ports/SpeciesCatalogPort';

/** Enterprise's seed catalog plus additions snapshotted in this annotation only. */
export class EmbeddedCatalogPort implements SpeciesCatalogPort {
  private readonly additions = new Map<string, SpeciesEntryV1>();
  private readonly unsubscribe: () => void;
  private epoch = -1;
  private destroyed = false;

  constructor(
    private readonly seed: SpeciesCatalogV1,
    annotation: AnnotationDocumentPort,
  ) {
    assertCatalog(seed);
    this.seed = structuredClone(seed);
    this.unsubscribe = annotation.subscribe((snapshot) => {
      if (snapshot.epoch !== this.epoch) {
        this.epoch = snapshot.epoch;
        this.additions.clear();
      }
      for (const box of snapshot.document?.boxes ?? []) this.remember(box.species);
    });
  }

  async read(): Promise<SpeciesCatalogV1> {
    this.ensureAlive();
    const species = mergeSpecies(this.seed.species, [...this.additions.values()]);
    const catalog = { ...structuredClone(this.seed), species };
    assertCatalog(catalog);
    return catalog;
  }

  async create(input: CreateSpeciesInput): Promise<SpeciesEntryV1> {
    this.ensureAlive();
    const code = normalizeSpeciesCode(input.code);
    const speciesName = normalizeSpeciesName(input.speciesName);
    const scientificName = input.scientificName
      ? normalizeSpeciesName(input.scientificName)
      : undefined;
    if (!/^[A-Z]{3}$/u.test(code)) {
      throw new ValidationError('Code must contain exactly three letters A–Z');
    }
    if (!speciesName) throw new ValidationError('Full Species Name is required');
    const catalog = await this.read();
    const existing = catalog.species.find(
      (entry) => entry.code.toLocaleLowerCase('en') === code.toLocaleLowerCase('en'),
    );
    if (existing) {
      if (
        existing.speciesName === speciesName &&
        (existing.scientificName ?? undefined) === scientificName
      ) {
        return structuredClone(existing);
      }
      throw new ValidationError(`Code ${code} already belongs to ${existing.speciesName}`);
    }
    const now = new Date().toISOString();
    const created: SpeciesEntryV1 = {
      schemaVersion: 1,
      kind: 'froglabel.species',
      speciesId: `local:${crypto.randomUUID()}`,
      code,
      speciesName,
      ...(scientificName ? { scientificName } : {}),
      addedAfterInitialization: true,
      createdAt: now,
      updatedAt: now,
    };
    this.additions.set(created.speciesId, created);
    return structuredClone(created);
  }

  canCreate(): boolean {
    return !this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe();
    this.additions.clear();
  }

  private remember(snapshot: SpeciesSnapshotV1): void {
    if (!snapshot.addedAfterInitialization) return;
    const seed = this.seed.species.find((entry) => entry.speciesId === snapshot.speciesId);
    if (seed) return;
    const now = new Date().toISOString();
    this.additions.set(snapshot.speciesId, {
      schemaVersion: 1,
      kind: 'froglabel.species',
      ...structuredClone(snapshot),
      createdAt: now,
      updatedAt: now,
    });
  }

  private ensureAlive(): void {
    if (this.destroyed) throw new Error('Embedded catalog port has been destroyed.');
  }
}

function mergeSpecies(
  seed: readonly SpeciesEntryV1[],
  additions: readonly SpeciesEntryV1[],
): SpeciesEntryV1[] {
  const byId = new Map(seed.map((entry) => [entry.speciesId, structuredClone(entry)]));
  for (const addition of additions) {
    const existing = byId.get(addition.speciesId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(addition)) {
      throw new ValidationError(`Species ${addition.speciesId} conflicts with the embedded seed`);
    }
    byId.set(addition.speciesId, structuredClone(addition));
  }
  const values = [...byId.values()].sort((left, right) => left.code.localeCompare(right.code));
  const codes = new Map<string, string>();
  for (const entry of values) {
    const folded = entry.code.toLowerCase();
    const other = codes.get(folded);
    if (other && other !== entry.speciesId) {
      throw new ValidationError(`Current code ${entry.code} has more than one immutable ID`);
    }
    codes.set(folded, entry.speciesId);
  }
  return values;
}
