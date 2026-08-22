import { describe, expect, it, vi } from 'vitest';
import {
  EnterpriseInlineReactCodePort,
  type EnterpriseInlineHostProps,
  type EnterpriseInlineRegion,
} from '../../src/adapters/enterprise/EnterpriseInlineReactCodePort';
import { document } from '../fixtures';

class MutableHost {
  readonly regions: EnterpriseInlineRegion[] = [];
  nextId = 1;
  reject = false;
  echo = true;
  props: EnterpriseInlineHostProps = {
    React: {},
    data: { froglabel: '/audio/task-one.wav' },
    viewState: { locked: false, editable: true },
    regions: this.regions,
    addRegion: (value) => {
      if (this.reject) throw new Error('host rejected add');
      const region = this.region(`host:${this.nextId++}`, value);
      if (this.echo) this.regions.push(region);
      return region;
    },
  };

  region(id: string, value: unknown): EnterpriseInlineRegion {
    const region: EnterpriseInlineRegion = {
      id,
      value,
      selected: false,
      hidden: false,
      locked: false,
      update: (next) => {
        if (this.reject) throw new Error('host rejected update');
        if (this.echo) region.value = next;
      },
      delete: () => {
        if (this.reject) throw new Error('host rejected delete');
        if (this.echo) this.regions.splice(this.regions.indexOf(region), 1);
      },
    };
    return region;
  }
}

describe('EnterpriseInlineReactCodePort documented-props boundary', () => {
  it('creates, updates, and deletes one stable outer region after authoritative echoes', async () => {
    const host = new MutableHost();
    const port = new EnterpriseInlineReactCodePort(host.props);
    await port.replaceDocument(document, 'box/createCommitted');
    expect(host.regions).toHaveLength(1);
    expect(port.getSnapshot()).toMatchObject({ regionId: 'host:1', document });

    const updated = structuredClone(document);
    updated.boxes[0].endTimeSeconds = 5.875;
    await port.replaceDocument(updated, 'box/resizeCommitted');
    expect(host.regions[0].id).toBe('host:1');
    expect(port.getSnapshot().document?.boxes[0].endTimeSeconds).toBe(5.875);

    await port.replaceDocument(null, 'box/delete');
    expect(host.regions).toHaveLength(0);
    expect(port.getSnapshot()).toMatchObject({ regionId: null, document: null });
    port.destroy();
  });

  it('waits for delayed host echo and times out a rejected echo without optimism', async () => {
    vi.useFakeTimers();
    const host = new MutableHost();
    host.echo = false;
    const port = new EnterpriseInlineReactCodePort(host.props, {
      mutationTimeoutMilliseconds: 100,
    });
    const pending = port.replaceDocument(document, 'box/createCommitted');
    await vi.advanceTimersByTimeAsync(20);
    expect(port.getStatus().phase).toBe('saving');
    expect(port.getSnapshot().document).toBeNull();

    const echoed = host.region('host:delayed', document);
    host.regions.push(echoed);
    port.updateContext(host.props);
    await expect(pending).resolves.toBeUndefined();

    host.echo = false;
    const changed = structuredClone(document);
    changed.boxes[0].highFrequencyHz = 2_600;
    const rejected = port.replaceDocument(changed, 'box/resizeCommitted');
    const assertion = expect(rejected).rejects.toMatchObject({ code: 'ENTERPRISE_SAVE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(110);
    await assertion;
    expect(port.getSnapshot().document).toEqual(document);
    expect(port.getStatus()).toMatchObject({
      phase: 'error',
      error: { code: 'ENTERPRISE_SAVE_TIMEOUT' },
    });
    port.destroy();
    vi.useRealTimers();
  });

  it('fails read-only for duplicates/malformed regions and rejects on epoch change', async () => {
    const host = new MutableHost();
    const port = new EnterpriseInlineReactCodePort(host.props);
    host.echo = false;
    const pending = port.replaceDocument(document, 'box/createCommitted');
    const epochAssertion = expect(pending).rejects.toMatchObject({
      code: 'ENTERPRISE_EPOCH_CHANGED',
    });
    await Promise.resolve();
    host.props = { ...host.props, data: { froglabel: '/audio/task-two.wav' }, regions: [] };
    port.updateContext(host.props);
    await epochAssertion;

    const one = host.region('one', document);
    const two = host.region('two', document);
    port.updateContext({ ...host.props, regions: [one, two] });
    expect(port.getStatus()).toMatchObject({
      phase: 'error',
      locked: true,
      error: { code: 'ENTERPRISE_HOST_CONTEXT_INVALID' },
    });
    await expect(port.replaceDocument(null, 'box/delete')).rejects.toMatchObject({
      code: 'ENTERPRISE_HOST_CONTEXT_INVALID',
    });
    port.destroy();
  });

  it('honors viewState locks and performs complete cleanup', async () => {
    const host = new MutableHost();
    const port = new EnterpriseInlineReactCodePort({
      ...host.props,
      viewState: { locked: true, editable: false, currentScreen: 'review_stream' },
    });
    expect(port.getStatus()).toMatchObject({ phase: 'read-only', locked: true });
    await expect(port.replaceDocument(document, 'box/createCommitted')).rejects.toMatchObject({
      code: 'ENTERPRISE_HOST_READ_ONLY',
    });
    port.destroy();
    expect(() => port.updateContext(host.props)).toThrowError(/closed/u);
  });
});
