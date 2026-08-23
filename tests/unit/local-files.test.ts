import { describe, expect, it } from 'vitest';
import {
  buildLocalFile,
  catalogFromLocalFile,
  serializeLocalFile,
} from '../../src/adapters/local/localFiles';
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

  it('round-trips historical catalog records separately from active species', () => {
    const value = buildLocalFile(
      {
        filename: 'legacy.wav',
        sizeBytes: 42,
        durationSeconds: 30,
        sampleRateHz: 44_100,
        channelCount: 1,
        fingerprint: { algorithm: 'sha256', value: 'b'.repeat(64), scope: 'file-bytes' },
      },
      {
        ...catalog,
        historicalSpecies: [
          {
            schemaVersion: 1,
            kind: 'froglabel.species',
            speciesId: 'legacy:red',
            code: 'RED',
            speciesName: 'Legacy Red Frog',
            addedAfterInitialization: false,
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
        ],
      },
      null,
    );

    expect(value.catalogSnapshot).toEqual(catalog.species);
    expect(value.historicalCatalogSnapshot?.[0]).toMatchObject({
      schemaVersion: 1,
      speciesId: 'legacy:red',
      code: 'RED',
    });
    expect(JSON.parse(serializeLocalFile(value))).toEqual(value);
  });

  it('accepts the complete 5,000-box contract limit and rejects one more', () => {
    const template = document.boxes[0];
    const boxes = Array.from({ length: 5_000 }, (_, index) => {
      const timeCell = index % 100;
      const frequencyCell = Math.floor(index / 100);
      const startTimeSeconds = 0.01 + timeCell * 0.29;
      const lowFrequencyHz = 100 + frequencyCell * 400;
      return {
        ...template,
        id: `box:maximum-${index.toString().padStart(4, '0')}`,
        startTimeSeconds,
        endTimeSeconds: startTimeSeconds + 0.1,
        lowFrequencyHz,
        highFrequencyHz: lowFrequencyHz + 200,
      };
    });
    const audio = {
      filename: 'maximum.wav',
      sizeBytes: 42,
      durationSeconds: 30,
      sampleRateHz: 44_100,
      channelCount: 1 as const,
      fingerprint: {
        algorithm: 'sha256' as const,
        value: 'c'.repeat(64),
        scope: 'file-bytes' as const,
      },
    };
    const maximum = buildLocalFile(audio, catalog, { ...document, boxes });
    expect(maximum.document?.boxes).toHaveLength(5_000);
    expect(catalogFromLocalFile(maximum).species).toEqual(catalog.species);
    expect(() =>
      buildLocalFile(audio, catalog, {
        ...document,
        boxes: [...boxes, { ...boxes[0], id: 'box:over-limit' }],
      }),
    ).toThrow('Annotation document is invalid');
  });
});
