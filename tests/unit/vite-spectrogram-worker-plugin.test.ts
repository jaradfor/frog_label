// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { spectrogramWorkerSource } from '../../scripts/vite-spectrogram-worker-plugin.mjs';

const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories.splice(0).map((repository) => rm(repository, { recursive: true })),
  );
});

describe('spectrogram worker Vite plugin', () => {
  it('watches transitive inputs and rebuilds the virtual module before a dev reload', async () => {
    const repository = await createWorkerRepository('before-change');
    const dependency = path.join(repository, 'src', 'workers', 'nested-value.ts');
    const plugin = spectrogramWorkerSource(repository);
    const resolvedId = plugin.resolveId('virtual:froglabel-spectrogram-worker');
    if (!resolvedId) throw new Error('The worker virtual module was not resolved.');

    plugin.configResolved({ command: 'serve' });
    const addWatchFile = vi.fn();
    const initialModule = await plugin.load.call({ addWatchFile }, resolvedId);

    expect(initialModule).toContain('before-change');
    expect(addWatchFile).toHaveBeenCalledWith(dependency);

    await writeFile(dependency, "export const workerValue = 'after-change';\n");
    plugin.watchChange(dependency);

    const workerModule = {};
    const moduleGraph = {
      getModuleById: vi.fn(() => workerModule),
      invalidateModule: vi.fn(),
    };
    const send = vi.fn();
    const hotUpdateResult = await plugin.handleHotUpdate.call(
      { addWatchFile },
      {
        file: dependency,
        server: { moduleGraph, ws: { send } },
      },
    );

    expect(hotUpdateResult).toEqual([]);
    expect(moduleGraph.getModuleById).toHaveBeenCalledWith(resolvedId);
    expect(moduleGraph.invalidateModule).toHaveBeenCalledWith(workerModule);
    expect(send).toHaveBeenCalledWith({ type: 'full-reload' });
    expect(await plugin.load.call({ addWatchFile }, resolvedId)).toContain('after-change');
  });

  it('keeps independent production compilations byte-identical', async () => {
    const repository = await createWorkerRepository('deterministic');
    const firstPlugin = spectrogramWorkerSource(repository);
    const secondPlugin = spectrogramWorkerSource(repository);
    const firstId = firstPlugin.resolveId('virtual:froglabel-spectrogram-worker');
    const secondId = secondPlugin.resolveId('virtual:froglabel-spectrogram-worker');
    if (!firstId || !secondId) throw new Error('The worker virtual module was not resolved.');

    firstPlugin.configResolved({ command: 'build' });
    secondPlugin.configResolved({ command: 'build' });
    const context = { addWatchFile: vi.fn() };

    expect(await firstPlugin.load.call(context, firstId)).toBe(
      await secondPlugin.load.call(context, secondId),
    );
  });
});

async function createWorkerRepository(value: string): Promise<string> {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'froglabel-worker-plugin-'));
  temporaryRepositories.push(repository);
  const workerDirectory = path.join(repository, 'src', 'workers');
  await mkdir(workerDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(workerDirectory, 'spectrogram.worker.ts'),
      "import { workerValue } from './worker-value';\nself.postMessage(workerValue);\n",
    ),
    writeFile(
      path.join(workerDirectory, 'worker-value.ts'),
      "export { workerValue } from './nested-value';\n",
    ),
    writeFile(
      path.join(workerDirectory, 'nested-value.ts'),
      `export const workerValue = '${value}';\n`,
    ),
  ]);
  return repository;
}
