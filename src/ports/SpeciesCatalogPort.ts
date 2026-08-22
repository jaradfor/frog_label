import type { SpeciesCatalogV1, SpeciesEntryV1 } from '../domain/types';

export interface CreateSpeciesInput {
  code: string;
  speciesName: string;
  scientificName?: string;
}

export interface SpeciesCatalogPort {
  read(signal?: AbortSignal): Promise<SpeciesCatalogV1>;
  create(input: CreateSpeciesInput, signal?: AbortSignal): Promise<SpeciesEntryV1>;
  canCreate(): boolean;
  destroy(): void;
}
