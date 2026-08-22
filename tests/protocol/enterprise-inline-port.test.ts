import { describe, expect, it, vi } from 'vitest';
import {
  EnterpriseInterfacePort,
  getEnterpriseInterfaceResults,
  parseEnterpriseInterfaceResults,
  type EnterpriseInterfaceHostProps,
  type EnterpriseInterfaceScreenRegion,
} from '../../src/adapters/enterprise/EnterpriseInterfacePort';
import { document } from '../fixtures';

class MutableHost {
  readonly regions: EnterpriseInterfaceScreenRegion[] = [];
  nextId = 1;
  reject = false;
  echo = true;
  props: EnterpriseInterfaceHostProps = {
    task: { id: 1, data: { audio: '/audio/task-one.wav' } },
    readOnly: false,
    regions: this.regions,
    addRegion: (region) => {
      if (this.reject) throw new Error('host rejected add');
      const added = this.region(`host:${this.nextId++}`, region._froglabelDocument);
      if (this.echo) this.regions.push(added);
      return added;
    },
    updateRegion: (id, patch) => {
      if (this.reject) throw new Error('host rejected update');
      const region = this.regions.find((candidate) => candidate.id === id);
      if (this.echo && region) Object.assign(region, structuredClone(patch));
    },
    deleteRegion: (id) => {
      if (this.reject) throw new Error('host rejected delete');
      const index = this.regions.findIndex((candidate) => candidate.id === id);
      if (this.echo && index >= 0) this.regions.splice(index, 1);
    },
  };

  region(id: string, value: unknown): EnterpriseInterfaceScreenRegion {
    return {
      id,
      type: 'textarea',
      labels: [],
      colors: [],
      score: null,
      selected: false,
      hidden: false,
      locked: false,
      parentId: null,
      text: 'FrogLabel',
      _froglabelDocument: structuredClone(value),
    };
  }
}

describe('EnterpriseInterfacePort controlled-runtime boundary', () => {
  it('creates, updates, and deletes one stable outer region after authoritative echoes', async () => {
    const host = new MutableHost();
    const port = new EnterpriseInterfacePort(host.props);
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
    const port = new EnterpriseInterfacePort(host.props, {
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
    const port = new EnterpriseInterfacePort(host.props);
    host.echo = false;
    const pending = port.replaceDocument(document, 'box/createCommitted');
    const epochAssertion = expect(pending).rejects.toMatchObject({
      code: 'ENTERPRISE_EPOCH_CHANGED',
    });
    await Promise.resolve();
    host.props = {
      ...host.props,
      task: { id: 2, data: { audio: '/audio/task-two.wav' } },
      regions: [],
    };
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
    const port = new EnterpriseInterfacePort({
      ...host.props,
      readOnly: true,
    });
    expect(port.getStatus()).toMatchObject({ phase: 'read-only', locked: true });
    await expect(port.replaceDocument(document, 'box/createCommitted')).rejects.toMatchObject({
      code: 'ENTERPRISE_HOST_READ_ONLY',
    });
    port.destroy();
    expect(() => port.updateContext(host.props)).toThrowError(/closed/u);
  });

  it('round-trips canonical Interface textarea results and loads legacy ReactCode results', () => {
    const region = new MutableHost().region('host:stable', document);
    const serialized = getEnterpriseInterfaceResults([region], []);
    expect(serialized).toHaveLength(1);
    expect(serialized[0]).toMatchObject({
      id: 'host:stable',
      from_name: 'froglabel',
      to_name: 'audio',
      type: 'labels',
    });
    expect(parseEnterpriseInterfaceResults(serialized).regions[0]._froglabelDocument).toEqual(
      document,
    );

    const legacy = parseEnterpriseInterfaceResults([
      {
        id: 'legacy:stable',
        from_name: 'froglabel',
        to_name: 'froglabel',
        type: 'reactcode',
        value: { reactcode: document },
      },
    ]);
    expect(legacy.regions[0]).toMatchObject({
      id: 'legacy:stable',
      _froglabelDocument: document,
    });
  });
});
