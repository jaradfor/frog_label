import { describe, expect, it, vi } from 'vitest';
import { ReactCodeSrcPort } from '../../src/adapters/reactcode/ReactCodeSrcPort';
import { document } from '../fixtures';

class FakeRuntime extends EventTarget {
  readonly sent: Array<{ message: unknown; origin: string }> = [];
  readonly parent = {
    postMessage: (message: unknown, origin: string) => this.sent.push({ message, origin }),
  };
  readonly document = { referrer: 'https://labels.test/projects/42/data' };
  readonly location = {
    href: 'https://labels.test/react-app/froglabel/index.html',
    origin: 'https://labels.test',
  };

  hostMessage(data: unknown, options: { origin?: string; source?: object } = {}): void {
    const event = new Event('message');
    Object.defineProperties(event, {
      data: { value: data },
      origin: { value: options.origin ?? 'https://labels.test' },
      source: { value: options.source ?? this.parent },
    });
    this.dispatchEvent(event);
  }
}

function init(runtime: FakeRuntime, regions: unknown[] = [], context = '42:annotation:1'): void {
  runtime.hostMessage({
    type: 'init',
    tag: 'froglabel',
    context,
    data: '/media/call.wav',
    code: '',
    regions,
    viewState: null,
  });
}

describe('ReactCodeSrcPort', () => {
  it('posts ready only to the exact parent origin and accepts a valid initialization', () => {
    vi.useFakeTimers();
    const runtime = new FakeRuntime();
    const port = new ReactCodeSrcPort({
      window: runtime as unknown as Window,
      readyIntervalMilliseconds: 20,
    });

    expect(runtime.sent[0]).toEqual({ message: { type: 'ready' }, origin: 'https://labels.test' });
    vi.advanceTimersByTime(45);
    expect(runtime.sent).toHaveLength(3);
    init(runtime);
    vi.advanceTimersByTime(100);
    expect(runtime.sent).toHaveLength(3);
    expect(port.getStatus().phase).toBe('ready');
    expect(port.getSnapshot()).toMatchObject({
      epoch: 1,
      tag: 'froglabel',
      data: '/media/call.wav',
    });

    port.destroy();
    vi.useRealTimers();
  });

  it('waits for the authoritative host echo before resolving a singleton add', async () => {
    const runtime = new FakeRuntime();
    const port = new ReactCodeSrcPort({ window: runtime as unknown as Window });
    init(runtime);
    const mutation = port.replaceDocument(document, 'box/createCommitted');
    await Promise.resolve();

    expect(port.getSnapshot().document).toBeNull();
    expect(port.getStatus().phase).toBe('saving');
    expect(runtime.sent.at(-1)?.message).toMatchObject({
      type: 'addRegion',
      tag: 'froglabel',
      context: '42:annotation:1',
      value: document,
    });

    runtime.hostMessage({
      type: 'regions',
      tag: 'froglabel',
      context: '42:annotation:1',
      regions: [
        {
          id: 'host:7',
          value: document,
          selected: false,
          hidden: false,
          locked: false,
          origin: 'manual',
        },
      ],
    });
    await mutation;
    expect(port.getSnapshot()).toMatchObject({ regionId: 'host:7', document });
    expect(port.getStatus().phase).toBe('ready');
    port.destroy();
  });

  it('invalidates an unacknowledged edit when the host epoch changes', async () => {
    const runtime = new FakeRuntime();
    const port = new ReactCodeSrcPort({ window: runtime as unknown as Window });
    init(runtime);
    const mutation = port.replaceDocument(document, 'box/createCommitted');
    await Promise.resolve();
    runtime.hostMessage({
      type: 'update',
      tag: 'froglabel',
      context: '42:annotation:2',
      data: '/media/next.wav',
      regions: [],
      viewState: null,
    });
    await expect(mutation).rejects.toMatchObject({ code: 'HOST_EPOCH_CHANGED' });
    expect(port.getSnapshot()).toMatchObject({ epoch: 2, data: '/media/next.wav', document: null });
    port.destroy();
  });

  it('blocks locked prediction edits and rejects duplicate singleton regions', async () => {
    const runtime = new FakeRuntime();
    const port = new ReactCodeSrcPort({ window: runtime as unknown as Window });
    init(runtime, [
      {
        id: 'prediction:1',
        value: document,
        selected: false,
        hidden: false,
        locked: true,
        origin: 'prediction',
      },
    ]);
    await expect(port.replaceDocument(null, 'box/delete')).rejects.toMatchObject({
      code: 'HOST_READ_ONLY',
    });

    runtime.hostMessage({
      type: 'regions',
      tag: 'froglabel',
      context: '42:annotation:1',
      regions: [
        { id: 'one', value: document, selected: false, hidden: false, locked: false },
        { id: 'two', value: document, selected: false, hidden: false, locked: false },
      ],
    });
    expect(port.getStatus()).toMatchObject({
      phase: 'error',
      error: { code: 'HOST_CONTEXT_INVALID' },
    });
    port.destroy();
  });

  it('honors annotation read-only view state even when no singleton exists', async () => {
    const runtime = new FakeRuntime();
    const port = new ReactCodeSrcPort({ window: runtime as unknown as Window });
    runtime.hostMessage({
      type: 'init',
      tag: 'froglabel',
      context: '42:annotation:1',
      data: '/media/call.wav',
      code: '',
      regions: [],
      viewState: { locked: true, editable: false },
    });
    expect(port.getStatus()).toMatchObject({ phase: 'read-only', locked: true });
    await expect(port.replaceDocument(document, 'box/createCommitted')).rejects.toMatchObject({
      code: 'HOST_READ_ONLY',
    });

    runtime.hostMessage({
      type: 'viewState',
      tag: 'froglabel',
      context: '42:annotation:1',
      viewState: { locked: false, editable: true },
    });
    expect(port.getStatus()).toMatchObject({ phase: 'ready', locked: false });
    port.destroy();
  });

  it('clears prior scientific state and remains locked during a null-data warm-up', () => {
    const runtime = new FakeRuntime();
    const port = new ReactCodeSrcPort({ window: runtime as unknown as Window });
    init(runtime, [
      {
        id: 'host:prior',
        value: document,
        selected: false,
        hidden: false,
        locked: false,
      },
    ]);
    runtime.hostMessage({
      type: 'init',
      tag: 'froglabel',
      context: '42:annotation:2',
      data: null,
      code: '',
      regions: [],
      viewState: null,
    });
    expect(port.getSnapshot()).toMatchObject({
      epoch: 2,
      data: null,
      document: null,
      regionId: null,
      locked: true,
    });
    expect(port.getStatus()).toMatchObject({ phase: 'waiting', locked: true });

    runtime.hostMessage({
      type: 'update',
      tag: 'froglabel',
      context: '42:annotation:2',
      data: null,
      regions: [
        {
          id: 'host:stale',
          value: document,
          selected: false,
          hidden: false,
          locked: false,
        },
      ],
      viewState: null,
    });
    expect(port.getStatus()).toMatchObject({ phase: 'waiting', locked: true });
    port.destroy();
  });

  it('ignores wrong origins and wrong sources', () => {
    const runtime = new FakeRuntime();
    const port = new ReactCodeSrcPort({ window: runtime as unknown as Window });
    runtime.hostMessage(
      {
        type: 'init',
        tag: 'froglabel',
        context: 'evil:1',
        data: '/evil.wav',
        code: '',
        regions: [],
        viewState: null,
      },
      { origin: 'https://attacker.test' },
    );
    runtime.hostMessage(
      {
        type: 'init',
        tag: 'froglabel',
        context: 'evil:1',
        data: '/evil.wav',
        code: '',
        regions: [],
        viewState: null,
      },
      { source: {} },
    );
    expect(port.getSnapshot().epoch).toBe(0);
    port.destroy();
  });

  it('rejects an app-to-host message sent in the host direction', () => {
    const runtime = new FakeRuntime();
    const port = new ReactCodeSrcPort({ window: runtime as unknown as Window });
    runtime.hostMessage({ type: 'ready' });
    expect(port.getStatus()).toMatchObject({
      phase: 'error',
      error: { code: 'HOST_MESSAGE_INVALID' },
    });
    port.destroy();
  });
});
