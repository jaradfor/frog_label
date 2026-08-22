import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { FrogLabelWorkspace } from '../../src/components/workspace/FrogLabelWorkspace';
import { MemoryAnnotationDocumentPort } from '../../src/adapters/memory/MemoryAnnotationDocumentPort';
import { MemoryAudioSourcePort } from '../../src/adapters/memory/MemoryAudioSourcePort';
import { MemorySpeciesCatalogPort } from '../../src/adapters/memory/MemorySpeciesCatalogPort';
import { catalog } from '../fixtures';

const destroyers: Array<() => void> = [];

afterEach(() => {
  cleanup();
  for (const destroy of destroyers.splice(0)) destroy();
});

function renderWorkspace() {
  const annotation = new MemoryAnnotationDocumentPort(null);
  const species = new MemorySpeciesCatalogPort(catalog);
  const audio = new MemoryAudioSourcePort(null);
  destroyers.push(
    () => annotation.destroy(),
    () => species.destroy(),
    () => audio.destroy(),
  );
  return render(
    <FrogLabelWorkspace
      annotationPort={annotation}
      catalogPort={species}
      audioSourcePort={audio}
      mode="demo"
    />,
  );
}

describe('FrogLabelWorkspace controls', () => {
  it('renders an actionable state instead of a blank spectrogram when audio is absent', async () => {
    const annotation = new MemoryAnnotationDocumentPort(null);
    const species = new MemorySpeciesCatalogPort(catalog);
    const audio = new MemoryAudioSourcePort(null);
    destroyers.push(
      () => annotation.destroy(),
      () => species.destroy(),
      () => audio.destroy(),
    );
    render(
      <FrogLabelWorkspace
        annotationPort={annotation}
        catalogPort={species}
        audioSourcePort={audio}
        mode="local"
        emptyAudioState={<button type="button">Open WAV or MP3</button>}
      />,
    );

    expect(await screen.findByText('Waiting for audio')).toBeVisible();
    expect(screen.getByText(/spectrogram will appear/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open WAV or MP3' })).toBeEnabled();
  });

  it('opens help without prompting automatically and preserves native focus order', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Help and tutorial' }));
    expect(screen.getByRole('dialog', { name: 'Tools and shortcuts' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Start 2-minute tutorial/ })).toBeEnabled();
    const close = screen.getByRole('button', { name: 'Close help' });
    fireEvent.keyDown(close, { code: 'Tab', key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: /Start 2-minute tutorial/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { code: 'Tab', key: 'Tab' });
    expect(close).toHaveFocus();
    await user.click(close);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.tab();
    expect(document.activeElement).toBeInstanceOf(HTMLElement);
  });

  it('uses one code-based dispatcher and ignores editable targets', async () => {
    renderWorkspace();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search' })).toBeVisible());
    const speciesButton = screen.getByRole('button', { name: '1 Species' });
    const detailsButton = screen.getByRole('button', { name: '2 Details' });
    expect(speciesButton).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { code: 'Digit1', key: '1' });
    expect(speciesButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(speciesButton);
    const search = screen.getByRole('textbox', { name: 'Search' });
    search.focus();
    fireEvent.keyDown(search, { code: 'Digit2', key: '2' });
    expect(detailsButton).toHaveAttribute('aria-pressed', 'true');
    expect(fireEvent.keyDown(search, { code: 'KeyZ', key: 'z', ctrlKey: true })).toBe(true);
    fireEvent.keyDown(window, { code: 'Digit2', key: '2', repeat: true });
    expect(detailsButton).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { code: 'Digit2', key: '2', ctrlKey: true });
    expect(detailsButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('advances tutorial Space from the focused coach and protects form controls', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(screen.getByRole('button', { name: 'Help and tutorial' }));
    await user.click(screen.getByRole('button', { name: /Start 2-minute tutorial/ }));
    const nextButton = screen.getByRole('button', { name: /^Next/ });
    nextButton.focus();
    fireEvent.keyDown(nextButton, { code: 'Space', key: ' ' });
    expect(screen.getByRole('dialog', { name: 'Tutorial step 2 of 12' })).toBeVisible();
    const secondNextButton = screen.getByRole('button', { name: /^Next/ });
    secondNextButton.focus();
    fireEvent.keyDown(secondNextButton, { code: 'Space', key: ' ' });
    expect(screen.getByRole('dialog', { name: 'Tutorial step 3 of 12' })).toBeVisible();

    const species = screen
      .getAllByLabelText('Current species')
      .find((element) => element.closest('.tutorial-practice-layer'))!;
    species.focus();
    fireEvent.keyDown(species, { code: 'Space', key: ' ' });
    expect(screen.getByRole('dialog', { name: 'Tutorial step 3 of 12' })).toBeVisible();
    fireEvent.keyDown(species, { code: 'Escape', key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /Tutorial step/ })).not.toBeInTheDocument();
  });
});
