import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrogLabelWorkspace } from '../../src/components/workspace/FrogLabelWorkspace';
import { MemoryAnnotationDocumentPort } from '../../src/adapters/memory/MemoryAnnotationDocumentPort';
import { MemoryAudioSourcePort } from '../../src/adapters/memory/MemoryAudioSourcePort';
import { MemorySpeciesCatalogPort } from '../../src/adapters/memory/MemorySpeciesCatalogPort';
import { catalog } from '../fixtures';

vi.mock('../../src/components/workspace/SpectrogramCanvas', async () => {
  const React = await import('react');
  return {
    SpectrogramCanvas({
      view,
    }: {
      view: {
        timeStartSeconds: number;
        timeEndSeconds: number;
      };
    }) {
      return React.createElement('div', {
        className: 'spectrogram-shell',
        'data-testid': 'short-audio-spectrogram',
        'data-view-time-start-seconds': view.timeStartSeconds,
        'data-view-time-end-seconds': view.timeEndSeconds,
      });
    },
  };
});

afterEach(cleanup);

describe('short-audio viewport bounds', () => {
  it('keeps E zoom within a 100 ms audio resource', async () => {
    const durationSeconds = 0.1;
    const annotation = new MemoryAnnotationDocumentPort(null);
    const species = new MemorySpeciesCatalogPort(catalog);
    const audio = new MemoryAudioSourcePort({
      url: pcmWavDataUrl(8_000, durationSeconds),
      filename: 'short-100ms.wav',
      mimeType: 'audio/wav',
    });

    render(
      <FrogLabelWorkspace
        annotationPort={annotation}
        catalogPort={species}
        audioSourcePort={audio}
        mode="demo"
      />,
    );

    const shell = await screen.findByTestId('short-audio-spectrogram');
    fireEvent.keyDown(window, { code: 'KeyE', key: 'e' });

    await waitFor(() => {
      const start = Number(shell.getAttribute('data-view-time-start-seconds'));
      const end = Number(shell.getAttribute('data-view-time-end-seconds'));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(durationSeconds);
      expect(end).toBeGreaterThan(start);
    });

    annotation.destroy();
    species.destroy();
    audio.destroy();
  });
});

function pcmWavDataUrl(sampleRateHz: number, durationSeconds: number): string {
  const frameCount = Math.round(sampleRateHz * durationSeconds);
  const dataBytes = frameCount * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
