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
  const repositoryRoot = path.resolve(repository);
  let bundledSource;
  let workerInputs = new Set();
  let developmentServer = false;

  async function compileSource() {
    const result = await build({
      absWorkingDir: repositoryRoot,
      entryPoints: [path.join(repositoryRoot, 'src', 'workers', 'spectrogram.worker.ts')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      sourcemap: false,
      write: false,
      metafile: true,
    });
    const output = result.outputFiles?.[0];
    if (!output) throw new Error('Spectrogram worker compilation produced no JavaScript.');

    return {
      source: output.text,
      inputs: new Set(
        Object.keys(result.metafile.inputs).map((input) =>
          path.normalize(path.resolve(repositoryRoot, input)),
        ),
      ),
    };
  }

  async function loadSource(pluginContext) {
    const pendingSource = (bundledSource ??= compileSource());
    try {
      const compiled = await pendingSource;
      if (bundledSource === pendingSource) workerInputs = compiled.inputs;
      for (const input of compiled.inputs) pluginContext.addWatchFile(input);
      return compiled.source;
    } catch (error) {
      if (bundledSource === pendingSource) bundledSource = undefined;
      throw error;
    }
  }

  function isWorkerInput(file) {
    return workerInputs.has(path.normalize(path.resolve(file)));
  }

  function invalidateSource(file) {
    if (!isWorkerInput(file)) return false;
    bundledSource = undefined;
    return true;
  }

  return {
    name: 'froglabel-spectrogram-worker-source',
    configResolved(config) {
      developmentServer = config.command === 'serve';
    },
    resolveId(id) {
      return id === PUBLIC_ID ? RESOLVED_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      return `export default ${JSON.stringify(await loadSource(this))};`;
    },
    watchChange(id) {
      invalidateSource(id);
    },
    async handleHotUpdate(context) {
      if (!developmentServer || !invalidateSource(context.file)) return;

      // Recompile before reloading so the next virtual-module request cannot
      // receive the previous source string from either this cache or Vite's.
      await loadSource(this);
      const workerModule = context.server.moduleGraph.getModuleById(RESOLVED_ID);
      if (workerModule) context.server.moduleGraph.invalidateModule(workerModule);
      context.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
