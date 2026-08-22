import { describe, expect, it } from 'vitest';
import { buildLocalFile, serializeLocalFile } from '../../src/adapters/local/localFiles';
import { catalog, document } from '../fixtures';

describe('local annotation files', () => {
  it('contains a file fingerprint and canonical document but no audio bytes', () => {
    const value = buildLocalFile(
      {
        filename: 'call.wav',
        sizeBytes: 42,
        mimeType: 'audio/wav',
        durationSeconds: 30,
        sampleRateHz: 44_100,
        channelCount: 1,
        fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64), scope: 'file-bytes' },
      },
      catalog,
      document,
    );
    const serialized = serializeLocalFile(value);
    expect(JSON.parse(serialized)).toEqual(value);
    expect(serialized).not.toContain('data:audio');
    expect(serialized).not.toContain('audioBytes');
  });
});
