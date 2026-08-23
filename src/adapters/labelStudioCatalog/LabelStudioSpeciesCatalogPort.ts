import { IntegrationError, ValidationError } from '../../domain/errors';
import type { SpeciesCatalog, SpeciesEntry } from '../../domain/types';
import { readCatalogWithHistory } from '../../domain/migrations';
import { normalizeSpeciesCode, normalizeSpeciesName } from '../../domain/validation';
import type { CreateSpeciesInput, SpeciesCatalogPort } from '../../ports/SpeciesCatalogPort';

interface CatalogResponse {
  catalog?: unknown;
  permissions?: { createSpecies?: unknown };
  createdSpeciesId?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export class LabelStudioSpeciesCatalogPort implements SpeciesCatalogPort {
  private destroyed = false;
  private createAllowed = true;

  constructor(
    private readonly projectId: number,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      throw new ValidationError('A positive Label Studio project ID is required');
    }
  }

  async read(signal?: AbortSignal): Promise<SpeciesCatalog> {
    this.ensureAlive();
    const response = await this.fetchSameOrigin(this.endpoint(), { signal });
    if (!response.ok) throw await responseError(response, 'Project catalog could not be read.');
    return this.acceptCatalog(await parseResponse(response));
  }

  async create(input: CreateSpeciesInput, signal?: AbortSignal): Promise<SpeciesEntry> {
    this.ensureAlive();
    if (!this.createAllowed) {
      throw new IntegrationError(
        'CATALOG_CREATE_FORBIDDEN',
        'Your project role can use existing species but cannot add one.',
      );
    }
    const code = normalizeSpeciesCode(input.code);
    const speciesName = normalizeSpeciesName(input.speciesName);
    const scientificName = input.scientificName
      ? normalizeSpeciesName(input.scientificName)
      : undefined;
    if (!/^[QWERTASDFGZXCVB]{1,6}$/u.test(code)) {
      throw new ValidationError('Code must contain 1–6 left-hand letters');
    }
    if (!speciesName) throw new ValidationError('Full Species Name is required');

    let catalog = await this.read(signal);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = matchingCode(catalog, code);
      if (existing) return reconcileExisting(existing, speciesName, scientificName);
      const response = await this.fetchSameOrigin(this.endpoint(), {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': readCookie('csrftoken'),
        },
        body: JSON.stringify({
          expectedRevision: catalog.catalogRevision,
          species: {
            code,
            selectionPriority: input.selectionPriority ?? 0,
            speciesName,
            ...(scientificName ? { scientificName } : {}),
          },
        }),
      });
      const body = await parseResponse(response);
      if (response.status === 403) {
        this.createAllowed = false;
        throw new IntegrationError(
          'CATALOG_PERMISSION_DENIED',
          'Your project role can use existing species but cannot add one.',
        );
      }
      if (response.status === 409 && body.error?.code === 'CATALOG_STALE') {
        catalog = this.acceptCatalog(body);
        const winner = matchingCode(catalog, code);
        if (winner) return reconcileExisting(winner, speciesName, scientificName);
        continue;
      }
      if (!response.ok) throw responseBodyError(response, body, 'Species could not be added.');
      catalog = this.acceptCatalog(body);
      const speciesId = typeof body.createdSpeciesId === 'string' ? body.createdSpeciesId : '';
      const created = catalog.species.find((entry) => entry.speciesId === speciesId);
      if (!created) {
        throw new IntegrationError(
          'CATALOG_RESPONSE_INVALID',
          'The catalog response omitted the created species.',
        );
      }
      return created;
    }
    throw new IntegrationError(
      'CATALOG_STALE',
      'The project catalog changed repeatedly. Refetch and try once more.',
    );
  }

  canCreate(): boolean {
    return this.createAllowed;
  }

  destroy(): void {
    this.destroyed = true;
  }

  private acceptCatalog(body: CatalogResponse): SpeciesCatalog {
    const catalog = readCatalogWithHistory(body.catalog);
    if (body.permissions && typeof body.permissions.createSpecies === 'boolean') {
      this.createAllowed = body.permissions.createSpecies;
    }
    return {
      ...catalog,
      species: [...catalog.species].sort((left, right) =>
        left.code.localeCompare(right.code, 'en', { sensitivity: 'base' }),
      ),
      ...(catalog.historicalSpecies
        ? {
            historicalSpecies: [...catalog.historicalSpecies].sort((left, right) =>
              left.code.localeCompare(right.code, 'en', { sensitivity: 'base' }),
            ),
          }
        : {}),
    };
  }

  private endpoint(): string {
    return `/froglabel/api/projects/${this.projectId}/catalog/`;
  }

  private async fetchSameOrigin(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin) {
      throw new IntegrationError(
        'CATALOG_ORIGIN_DENIED',
        'Catalog requests must stay on the Label Studio origin.',
      );
    }
    return this.fetcher.call(window, url, { ...init, credentials: 'same-origin' });
  }

  private ensureAlive(): void {
    if (this.destroyed) {
      throw new IntegrationError('CATALOG_DESTROYED', 'The catalog connection closed.');
    }
  }
}

function matchingCode(catalog: SpeciesCatalog, code: string): SpeciesEntry | undefined {
  return catalog.species.find(
    (entry) => entry.code.toLocaleLowerCase('en') === code.toLocaleLowerCase('en'),
  );
}

function reconcileExisting(
  existing: SpeciesEntry,
  speciesName: string,
  scientificName: string | undefined,
): SpeciesEntry {
  if (
    existing.speciesName !== speciesName ||
    (existing.scientificName ?? undefined) !== scientificName
  ) {
    throw new IntegrationError(
      'CATALOG_CODE_CONFLICT',
      `Code ${existing.code} already belongs to ${existing.speciesName}; resolve explicitly.`,
    );
  }
  return existing;
}

function readCookie(name: string): string {
  const prefix = `${encodeURIComponent(name)}=`;
  const part = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : '';
}

async function parseResponse(response: Response): Promise<CatalogResponse> {
  try {
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== 'object') throw new Error('Response is not an object');
    return body as CatalogResponse;
  } catch {
    throw new IntegrationError(
      'CATALOG_RESPONSE_INVALID',
      `Catalog endpoint returned invalid JSON (${response.status}).`,
    );
  }
}

function responseBodyError(
  response: Response,
  body: CatalogResponse,
  fallback: string,
): IntegrationError {
  const code = typeof body.error?.code === 'string' ? body.error.code : 'CATALOG_REQUEST_FAILED';
  const message = typeof body.error?.message === 'string' ? body.error.message : fallback;
  return new IntegrationError(code, message, { detail: `HTTP ${response.status}` });
}

async function responseError(response: Response, fallback: string): Promise<IntegrationError> {
  const body = await parseResponse(response);
  return responseBodyError(response, body, fallback);
}
