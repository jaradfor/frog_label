import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrogLabelWorkspace } from '../../src/components/workspace/FrogLabelWorkspace';
import { MemoryAnnotationDocumentPort } from '../../src/adapters/memory/MemoryAnnotationDocumentPort';
import { MemoryAudioSourcePort } from '../../src/adapters/memory/MemoryAudioSourcePort';
import { MemorySpeciesCatalogPort } from '../../src/adapters/memory/MemorySpeciesCatalogPort';
import type { LoadedAudio } from '../../src/audio/AudioResource';
import { catalog } from '../fixtures';

vi.mock('../../src/components/workspace/SpectrogramCanvas', async () => {
  const React = await import('react');
  return {
    SpectrogramCanvas({
      view,
      playheadSeconds,
      onSeek,
      onTimeWindowStartChange,
    }: {
      view: {
        durationSeconds: number;
        timeStartSeconds: number;
        timeEndSeconds: number;
        lowFrequencyHz: number;
        highFrequencyHz: number;
      };
      playheadSeconds: number;
      onSeek(timeSeconds: number): void;
      onTimeWindowStartChange(timeStartSeconds: number): void;
    }) {
      return React.createElement(
        'div',
        {
          className: 'spectrogram-shell',
          'data-testid': 'short-audio-spectrogram',
          'data-view-time-start-seconds': view.timeStartSeconds,
          'data-view-time-end-seconds': view.timeEndSeconds,
          'data-view-low-frequency-hz': view.lowFrequencyHz,
          'data-view-high-frequency-hz': view.highFrequencyHz,
          'data-playhead-seconds': playheadSeconds,
        },
        React.createElement(
          'button',
          { type: 'button', onClick: () => onSeek(view.durationSeconds * 0.75) },
          'Test waveform seek',
        ),
        React.createElement(
          'button',
          { type: 'button', onClick: () => onTimeWindowStartChange(view.durationSeconds * 0.4) },
          'Test overview pan',
        ),
      );
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

  it('routes waveform navigation and toggles playback follow with Shift+V', async () => {
    const durationSeconds = 1;
    const annotation = new MemoryAnnotationDocumentPort(null);
    const species = new MemorySpeciesCatalogPort(catalog);
    const audio = new MemoryAudioSourcePort({
      url: pcmWavDataUrl(8_000, durationSeconds),
      filename: 'one-second.wav',
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
    const follow = screen.getByRole('button', {
      name: 'Follow playhead during playback (Shift+V)',
    });
    expect(follow).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('.froglabel-app')).toHaveAttribute('data-auto-follow', 'off');
    fireEvent.keyDown(window, { code: 'KeyV', key: 'V', shiftKey: true });
    await waitFor(() => {
      expect(follow).toHaveAttribute('aria-pressed', 'true');
      expect(document.querySelector('.froglabel-app')).toHaveAttribute('data-auto-follow', 'on');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Test waveform seek' }));
    await waitFor(() =>
      expect(Number(shell.getAttribute('data-playhead-seconds'))).toBeCloseTo(0.75),
    );

    fireEvent.keyDown(window, { code: 'KeyE', key: 'e' });
    fireEvent.click(screen.getByRole('button', { name: 'Test overview pan' }));
    await waitFor(() => {
      expect(Number(shell.getAttribute('data-view-time-start-seconds'))).toBeCloseTo(0.2);
      expect(Number(shell.getAttribute('data-view-time-end-seconds'))).toBeCloseTo(1);
    });

    annotation.destroy();
    species.destroy();
    audio.destroy();
  });

  it('starts paused playback at the visible left edge only when time is zoomed', async () => {
    const durationSeconds = 2;
    const annotation = new MemoryAnnotationDocumentPort(null);
    const species = new MemorySpeciesCatalogPort(catalog);
    const audio = new MemoryAudioSourcePort({
      url: pcmWavDataUrl(8_000, durationSeconds),
      filename: 'two-seconds.wav',
      mimeType: 'audio/wav',
    });
    const capturedAudio: { current: LoadedAudio | null } = { current: null };

    render(
      <FrogLabelWorkspace
        annotationPort={annotation}
        catalogPort={species}
        audioSourcePort={audio}
        mode="demo"
        onAudioLoaded={(loaded) => {
          capturedAudio.current = loaded;
        }}
      />,
    );

    const shell = await screen.findByTestId('short-audio-spectrogram');
    await waitFor(() => expect(capturedAudio.current).not.toBeNull());
    const playback = capturedAudio.current?.element;
    if (!playback) throw new Error('Audio playback was not captured');
    const play = vi.spyOn(playback, 'play').mockResolvedValue();
    const playButton = screen.getByRole('button', { name: 'Play or pause audio (V)' });

    act(() => playback.seek(1.25));
    fireEvent.click(playButton);
    expect(playback.currentTime).toBeCloseTo(1.25);
    expect(play).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { code: 'KeyD', key: 'D', shiftKey: true });
    await waitFor(() => {
      expect(Number(shell.getAttribute('data-view-time-start-seconds'))).toBeCloseTo(0.2);
      expect(Number(shell.getAttribute('data-view-time-end-seconds'))).toBeCloseTo(1.8);
    });
    act(() => playback.seek(1.25));
    fireEvent.click(playButton);
    expect(playback.currentTime).toBeCloseTo(0.2);
    expect(Number(shell.getAttribute('data-playhead-seconds'))).toBeCloseTo(0.2);
    expect(play).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.expert-status-meta')?.textContent).not.toMatch(/ready.*ready/u);

    annotation.destroy();
    species.destroy();
    audio.destroy();
  });

  it('pages follow at the safe-zone edge and defers while a pointer gesture is held', async () => {
    const durationSeconds = 2;
    const annotation = new MemoryAnnotationDocumentPort(null);
    const species = new MemorySpeciesCatalogPort(catalog);
    const audio = new MemoryAudioSourcePort({
      url: pcmWavDataUrl(8_000, durationSeconds),
      filename: 'two-seconds.wav',
      mimeType: 'audio/wav',
    });
    const capturedAudio: { current: LoadedAudio | null } = { current: null };

    render(
      <FrogLabelWorkspace
        annotationPort={annotation}
        catalogPort={species}
        audioSourcePort={audio}
        mode="demo"
        onAudioLoaded={(loaded) => {
          capturedAudio.current = loaded;
        }}
      />,
    );

    const shell = await screen.findByTestId('short-audio-spectrogram');
    await waitFor(() => expect(capturedAudio.current).not.toBeNull());
    fireEvent.keyDown(window, { code: 'KeyD', key: 'D', shiftKey: true });
    await waitFor(() => {
      expect(Number(shell.getAttribute('data-view-time-start-seconds'))).toBeCloseTo(0.2);
      expect(Number(shell.getAttribute('data-view-time-end-seconds'))).toBeCloseTo(1.8);
    });
    const initialLow = shell.getAttribute('data-view-low-frequency-hz');
    const initialHigh = shell.getAttribute('data-view-high-frequency-hz');

    fireEvent.keyDown(window, { code: 'KeyV', key: 'V', shiftKey: true });
    const playback = capturedAudio.current?.element;
    if (!playback) throw new Error('Audio playback was not captured');
    act(() => {
      playback.seek(0.2);
      playback.dispatchEvent(new Event('play'));
    });
    expect(Number(shell.getAttribute('data-view-time-start-seconds'))).toBeCloseTo(0.2);
    expect(Number(shell.getAttribute('data-view-time-end-seconds'))).toBeCloseTo(1.8);

    fireEvent.pointerDown(window, { pointerId: 71, buttons: 1 });
    act(() => {
      playback.seek(1.75);
    });
    expect(Number(shell.getAttribute('data-view-time-start-seconds'))).toBeCloseTo(0.2);
    expect(Number(shell.getAttribute('data-view-time-end-seconds'))).toBeCloseTo(1.8);

    fireEvent.pointerUp(window, { pointerId: 71, buttons: 0 });
    act(() => playback.seek(1.76));
    await waitFor(() => {
      expect(Number(shell.getAttribute('data-view-time-start-seconds'))).toBeCloseTo(0.4);
      expect(Number(shell.getAttribute('data-view-time-end-seconds'))).toBeCloseTo(2);
    });
    expect(shell.getAttribute('data-view-low-frequency-hz')).toBe(initialLow);
    expect(shell.getAttribute('data-view-high-frequency-hz')).toBe(initialHigh);

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
