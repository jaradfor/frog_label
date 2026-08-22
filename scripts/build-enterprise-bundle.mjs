import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import react from '@vitejs/plugin-react';
import { build } from 'vite';

import { spectrogramWorkerSource } from './vite-spectrogram-worker-plugin.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const temporaryRoot = path.join(repository, '.cache', 'enterprise-build');
const resourceRoot = path.join(repository, 'python', 'froglabel_cli', 'resources');
const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
  cwd: repository,
  encoding: 'utf8',
}).trim();
const buildVersion = `1.0.0+${commit}`;

await rm(temporaryRoot, { recursive: true, force: true });
await mkdir(resourceRoot, { recursive: true });

const minified = await compile('minified', true);
const unminified = await compile('unminified', false);
scanExecutable(minified);

const bundlePath = path.join(resourceRoot, 'enterprise-bundle.js');
const manifestPath = path.join(resourceRoot, 'enterprise-bundle.manifest.json');
await writeFile(bundlePath, `${minified.trim()}\n`, 'utf8');
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      kind: 'froglabel.enterprise-component-bundle',
      schemaVersion: 1,
      buildVersion,
      sourceCommit: commit,
      entry: 'src/enterprise/entry.tsx',
      exportName: 'renderEnterpriseFrogLabel',
      hostReactExternal: true,
      bundledDependencies: ['generated JSON-schema validators'],
      embeddedAssets: ['scoped CSS', 'FrogLabel logo', 'spectrogram worker source'],
      minifiedBytes: Buffer.byteLength(minified),
      unminifiedBytes: Buffer.byteLength(unminified),
      forbiddenScan: 'passed',
    },
    null,
    2,
  )}\n`,
  'utf8',
);
await rm(temporaryRoot, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ bundlePath, manifestPath, buildVersion })}\n`);

async function compile(name, minify) {
  const output = path.join(temporaryRoot, name);
  await build({
    configFile: false,
    root: repository,
    logLevel: 'warn',
    define: {
      __FROGLABEL_BUILD_VERSION__: JSON.stringify(buildVersion),
    },
    plugins: [spectrogramWorkerSource(repository), hostJsxRuntime(), react()],
    build: {
      outDir: output,
      emptyOutDir: true,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      cssCodeSplit: false,
      minify: minify ? 'esbuild' : false,
      sourcemap: false,
      target: 'es2022',
      lib: {
        entry: path.join(repository, 'src', 'enterprise', 'entry.tsx'),
        formats: ['iife'],
        name: 'FrogLabelEnterpriseBundle',
        fileName: () => 'bundle.js',
      },
      rollupOptions: {
        external: ['react'],
        output: {
          globals: { react: '__FROGLABEL_HOST_REACT__' },
        },
      },
    },
  });
  return readFile(path.join(output, 'bundle.js'), 'utf8');
}

function hostJsxRuntime() {
  const runtime = '\0froglabel-host-jsx-runtime';
  return {
    name: 'froglabel-host-jsx-runtime',
    enforce: 'pre',
    resolveId(id) {
      return id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime' ? runtime : null;
    },
    load(id) {
      if (id !== runtime) return null;
      return `
        import React from 'react';
        export const Fragment = React.Fragment;
        function element(type, props, key) {
          return React.createElement(type, key === undefined ? props : { ...props, key });
        }
        export const jsx = element;
        export const jsxs = element;
        export const jsxDEV = element;
      `;
    },
  };
}

function scanExecutable(code) {
  const failures = [];
  const checks = [
    ['ES module import', /(^|[;{}])\s*import(?:\s|\()/mu],
    ['ES module export', /(^|[;{}])\s*export\s/mu],
    ['CommonJS require', /\brequire\s*\(/u],
    ['dynamic Function constructor', /\b(?:new\s+)?Function\s*\(/u],
    ['eval', /\beval\s*\(/u],
    ['ReactDOM', /\bReactDOM\b/u],
    ['source map/source URL', /source(?:Mapping)?URL/u],
    ['service worker', /serviceWorker\.register/u],
    ['FrogLabel backend', /\/froglabel\/api\//u],
  ];
  for (const [name, pattern] of checks) if (pattern.test(code)) failures.push(name);
  if (!code.includes('__FROGLABEL_HOST_REACT__')) failures.push('host React external marker');
  if (!code.includes('renderEnterpriseFrogLabel')) failures.push('expected bundle export');
  if (failures.length) throw new Error(`Enterprise executable scan failed: ${failures.join(', ')}`);
}
