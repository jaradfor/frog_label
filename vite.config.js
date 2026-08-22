import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

import { spectrogramWorkerSource } from './scripts/vite-spectrogram-worker-plugin.mjs';

function fakeCatalogApi() {
  const now = '2026-08-20T00:00:00.000Z';
  const descriptor = {
    schemaVersion: 1,
    kind: 'froglabel.species-catalog',
    catalogId: 'fake-host:project:42',
    initializedAt: now,
    initializedBy: 'FrogLabel deterministic host',
    catalogRevision: 1,
    defaultSpeciesId: null,
  };
  const species = [
    ['fake:gre', 'GRE', 'Green Tree Frog'],
    ['fake:per', 'PER', "Peron's Tree Frog"],
  ].map(([speciesId, code, speciesName]) => ({
    schemaVersion: 1,
    kind: 'froglabel.species',
    speciesId,
    code,
    speciesName,
    addedAfterInitialization: false,
    createdAt: now,
    updatedAt: now,
  }));
  return {
    name: 'froglabel-fake-catalog-api',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/froglabel/api/projects/42/catalog/' && request.method === 'GET') {
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              catalog: { ...descriptor, species },
              permissions: { createSpecies: true },
            }),
          );
          return;
        }
        if (url.pathname === '/froglabel/api/projects/42/catalog/' && request.method === 'POST') {
          let body = '';
          request.on('data', (chunk) => {
            body += chunk;
          });
          request.on('end', () => {
            try {
              const command = JSON.parse(body);
              const now = new Date().toISOString();
              const created = {
                schemaVersion: 1,
                kind: 'froglabel.species',
                speciesId: `fake:${command.species.code.toLowerCase()}`,
                ...command.species,
                addedAfterInitialization: true,
                createdAt: now,
                updatedAt: now,
              };
              species.push(created);
              descriptor.catalogRevision += 1;
              response.setHeader('Content-Type', 'application/json');
              response.end(
                JSON.stringify({
                  catalog: { ...descriptor, species },
                  permissions: { createSpecies: true },
                  createdSpeciesId: created.speciesId,
                }),
              );
            } catch {
              response.statusCode = 400;
              response.end('Invalid JSON');
            }
          });
          return;
        }
        next();
      });
    },
  };
}

// https://vite.dev/config/

export default defineConfig(({ mode }) => {
  const pages = mode === 'pages';
  return {
    ...(pages
      ? {
          root: path.resolve('pages'),
          publicDir: false,
          build: {
            outDir: path.resolve('build/pages'),
            emptyOutDir: true,
          },
        }
      : {}),
    base: globalThis.process?.env.FROGLABEL_BASE || '/frog_label/',
    server: {
      host: '127.0.0.1',
      allowedHosts: ['terminal.local'],
      watch: {
        ignored: [
          '**/vendor/**',
          '**/.venv/**',
          '**/.cache/**',
          '**/.pip-cache/**',
          '**/.yarn-cache/**',
          '**/test-results/**',
          '**/playwright-report/**',
        ],
      },
    },
    plugins: [
      spectrogramWorkerSource(path.resolve('.')),
      react(),
      ...(!pages ? [fakeCatalogApi()] : []),
    ],
    resolve: {
      alias: {
        react: path.resolve('./node_modules/react'),
        'react-dom': path.resolve('./node_modules/react-dom'),
      },
    },
  };
});
