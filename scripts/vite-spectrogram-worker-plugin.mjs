import path from 'node:path';

import { build } from 'esbuild';

const PUBLIC_ID = 'virtual:froglabel-spectrogram-worker';
const RESOLVED_ID = `\0${PUBLIC_ID}`;

/**
 * Bundle the spectrogram worker into a source string shared by every Vite target.
 *
 * Owning the resulting Blob URL in SpectrogramRenderer lets the browser finish
 * loading the worker before the URL is revoked. Vite's `?worker&inline` helper
 * revokes from inside the worker bootstrap, which Chromium reports as an aborted
 * request even when the worker runs successfully.
 */
export function spectrogramWorkerSource(repository = path.resolve('.')) {
  let bundledSource;

  async function loadSource() {
    bundledSource ??= build({
      entryPoints: [path.join(repository, 'src', 'workers', 'spectrogram.worker.ts')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      sourcemap: false,
      write: false,
    }).then((result) => {
      const output = result.outputFiles?.[0];
      if (!output) throw new Error('Spectrogram worker compilation produced no JavaScript.');
      return output.text;
    });
    return bundledSource;
  }

  return {
    name: 'froglabel-spectrogram-worker-source',
    resolveId(id) {
      return id === PUBLIC_ID ? RESOLVED_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      return `export default ${JSON.stringify(await loadSource())};`;
    },
  };
}
