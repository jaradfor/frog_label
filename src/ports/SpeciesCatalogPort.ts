import type { SpeciesCatalog, SpeciesEntry } from '../domain/types';

export interface CreateSpeciesInput {
  code: string;
  speciesName: string;
  scientificName?: string;
  selectionPriority?: number;
}

export interface SpeciesCatalogPort {
  read(signal?: AbortSignal): Promise<SpeciesCatalog>;
  create(input: CreateSpeciesInput, signal?: AbortSignal): Promise<SpeciesEntry>;
  canCreate(): boolean;
  destroy(): void;
}
