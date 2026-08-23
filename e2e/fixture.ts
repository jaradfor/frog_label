import { expect, test as base } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const IN_PROCESS = process.env.FROGLABEL_E2E_IN_PROCESS === '1';
const TEST_ORIGIN = 'http://localhost';
const BASE_PATH = '/frog_label/';
const DIST_ROOT = path.resolve(import.meta.dirname, '../dist');

type Species = {
  schemaVersion: number;
  kind: string;
  speciesId: string;
  code: string;
  selectionPriority: number;
  speciesName: string;
  addedAfterInitialization: boolean;
  createdAt: string;
  updatedAt: string;
};

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
};

function initialCatalog(): { descriptor: object; species: Species[] } {
  const now = '2026-08-20T00:00:00.000Z';
  return {
    descriptor: {
      schemaVersion: 2,
      kind: 'froglabel.species-catalog',
      catalogId: 'fake-host:project:42',
      initializedAt: now,
      initializedBy: 'FrogLabel deterministic host',
      catalogRevision: 1,
      defaultSpeciesId: null,
    },
    species: [
      ['fake:gre', 'GRE', 'Green Tree Frog'],
      ['fake:per', 'ETF', "Peron's Tree Frog"],
    ].map(([speciesId, code, speciesName]) => ({
      schemaVersion: 2,
      kind: 'froglabel.species',
      speciesId,
      code,
      selectionPriority: 0,
      speciesName,
      addedAfterInitialization: false,
      createdAt: now,
      updatedAt: now,
    })),
  };
}

async function staticAsset(pathname: string): Promise<{ body: Buffer; contentType: string }> {
  const relativeUrl = pathname.slice(BASE_PATH.length);
  const requested = path.resolve(DIST_ROOT, relativeUrl);
  if (requested !== DIST_ROOT && !requested.startsWith(`${DIST_ROOT}${path.sep}`)) {
    throw new Error(`Static request escaped dist: ${pathname}`);
  }
  let candidate = requested;
  try {
    if ((await stat(candidate)).isDirectory()) candidate = path.join(candidate, 'index.html');
    if ((await stat(candidate)).isFile()) {
      return {
        body: await readFile(candidate),
        contentType: contentTypes[path.extname(candidate)] ?? 'application/octet-stream',
      };
    }
  } catch {
    // Vite's history fallback serves the SPA for extensionless application routes.
  }
  if (!path.extname(relativeUrl.replace(/\/$/, ''))) {
    candidate = path.join(DIST_ROOT, 'index.html');
    return { body: await readFile(candidate), contentType: contentTypes['.html'] };
  }
  throw new Error(`Static asset does not exist: ${pathname}`);
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const unexpected: string[] = [];
    const catalog = initialCatalog();
    if (IN_PROCESS) {
      await page.addInitScript(() => {
        if (typeof crypto.randomUUID !== 'function') {
          Object.defineProperty(crypto, 'randomUUID', {
            configurable: true,
            value: () => {
              const bytes = crypto.getRandomValues(new Uint8Array(16));
              bytes[6] = (bytes[6] & 0x0f) | 0x40;
              bytes[8] = (bytes[8] & 0x3f) | 0x80;
              const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'));
              return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
                .slice(6, 8)
                .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
            },
          });
        }
      });
    }
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (IN_PROCESS) {
        if (url.origin !== TEST_ORIGIN) {
          unexpected.push(url.href);
          await route.abort('blockedbyclient');
          return;
        }
        if (url.pathname === '/froglabel/api/projects/42/catalog/' && request.method() === 'GET') {
          await route.fulfill({
            json: {
              catalog: { ...catalog.descriptor, species: catalog.species },
              permissions: { createSpecies: true },
            },
          });
          return;
        }
        if (url.pathname === '/froglabel/api/projects/42/catalog/' && request.method() === 'POST') {
          const command = request.postDataJSON() as {
            species: {
              code: string;
              selectionPriority: number;
              speciesName: string;
              scientificName?: string;
            };
          };
          const now = new Date().toISOString();
          const created: Species = {
            schemaVersion: 2,
            kind: 'froglabel.species',
            speciesId: `fake:${command.species.code.toLowerCase()}`,
            ...command.species,
            addedAfterInitialization: true,
            createdAt: now,
            updatedAt: now,
          };
          catalog.species.push(created);
          const descriptor = catalog.descriptor as { catalogRevision: number };
          descriptor.catalogRevision += 1;
          await route.fulfill({
            json: {
              catalog: { ...catalog.descriptor, species: catalog.species },
              permissions: { createSpecies: true },
              createdSpeciesId: created.speciesId,
            },
          });
          return;
        }
        if (
          ['/api/label_links', '/api/label_links/'].includes(url.pathname) &&
          request.method() === 'GET'
        ) {
          const records = [catalog.descriptor, ...catalog.species].map((value, index) => ({
            from_name: 'froglabel_species_v1',
            label: { id: index + 1, title: `froglabel:v1:project:42:${index}`, value },
          }));
          await route.fulfill({ json: records });
          return;
        }
        if (['/api/labels', '/api/labels/'].includes(url.pathname) && request.method() === 'POST') {
          const records = request.postDataJSON() as Array<{ value: Species }>;
          catalog.species.push(...records.map((record) => record.value));
          await route.fulfill({ json: records });
          return;
        }
        if (!url.pathname.startsWith(BASE_PATH)) {
          unexpected.push(url.href);
          await route.abort('blockedbyclient');
          return;
        }
        try {
          const asset = await staticAsset(url.pathname);
          await route.fulfill({
            body: asset.body,
            headers: { 'content-type': asset.contentType, 'cache-control': 'no-store' },
          });
        } catch {
          unexpected.push(url.href);
          await route.abort('failed');
        }
        return;
      }
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
        unexpected.push(url.href);
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    (page as typeof page & { unexpectedRequests?: string[] }).unexpectedRequests = unexpected;
    await use(page);
  },
});

test.afterEach(async ({ page }) => {
  expect((page as typeof page & { unexpectedRequests?: string[] }).unexpectedRequests).toEqual([]);
});

export { expect };
