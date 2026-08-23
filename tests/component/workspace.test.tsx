import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { FrogLabelWorkspace } from '../../src/components/workspace/FrogLabelWorkspace';
import { MemoryAnnotationDocumentPort } from '../../src/adapters/memory/MemoryAnnotationDocumentPort';
import { MemoryAudioSourcePort } from '../../src/adapters/memory/MemoryAudioSourcePort';
import { MemorySpeciesCatalogPort } from '../../src/adapters/memory/MemorySpeciesCatalogPort';
import type { SpeciesCatalog } from '../../src/domain/types';
import { catalog } from '../fixtures';

const destroyers: Array<() => void> = [];

afterEach(() => {
  cleanup();
  for (const destroy of destroyers.splice(0)) destroy();
});

const expertCatalog: SpeciesCatalog = {
  ...catalog,
  species: [
    {
      schemaVersion: 2,
      kind: 'froglabel.species',
      speciesId: 'local:green-tree-frog',
      code: 'GRE',
      selectionPriority: 10,
      speciesName: 'Green Tree Frog',
      addedAfterInitialization: false,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    },
    {
      schemaVersion: 2,
      kind: 'froglabel.species',
      speciesId: 'local:gray-tree-frog',
      code: 'GRA',
      selectionPriority: 0,
      speciesName: 'Gray Tree Frog',
      addedAfterInitialization: false,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    },
    ...catalog.species,
  ],
};

function renderWorkspace(speciesCatalog: SpeciesCatalog = catalog) {
  const annotation = new MemoryAnnotationDocumentPort(null);
  const species = new MemorySpeciesCatalogPort(speciesCatalog);
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
  it('shows legacy catalog entries as historical without making them selectable', async () => {
    const user = userEvent.setup();
    renderWorkspace({
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
    });

    await user.click(screen.getByRole('button', { name: '1 Species' }));
    const historical = await screen.findByRole('option', {
      name: /RED Legacy Red Frog.*historical/i,
    });
    expect(historical).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByText(/shown for reference but cannot be selected.*project administrator/i),
    ).toBeVisible();

    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    fireEvent.keyDown(window, { code: 'KeyR', key: 'r' });
    expect(document.querySelector('.expert-status-line')).toHaveAttribute(
      'data-species-candidate',
      '',
    );
    fireEvent.keyUp(window, { code: 'Space', key: ' ' });
  });

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
    const speciesButton = screen.getByRole('button', { name: '1 Species' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Help and tutorial' }));
    expect(screen.getByRole('dialog', { name: 'Tools and shortcuts' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Start 2-minute tutorial/ })).toBeEnabled();
    expect(screen.getAllByText('Undo annotation edit')).toHaveLength(1);
    expect(screen.queryByText(/Undo; add Shift to redo/i)).not.toBeInTheDocument();
    const close = screen.getByRole('button', { name: 'Close help' });
    fireEvent.keyDown(close, { code: 'Digit1', key: '1' });
    expect(speciesButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(close, { code: 'Tab', key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: /Start 2-minute tutorial/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { code: 'Tab', key: 'Tab' });
    expect(close).toHaveFocus();
    await user.click(close);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.tab();
    expect(document.activeElement).toBeInstanceOf(HTMLElement);
  });

  it('starts with docked panels closed and routes digits from buttons but not fields or held pointers', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const speciesButton = screen.getByRole('button', { name: '1 Species' });
    const detailsButton = screen.getByRole('button', { name: '2 Details' });
    const displayButton = screen.getByRole('button', { name: '3 Display' });
    const datasetButton = screen.getByRole('button', { name: '4 Dataset' });
    for (const button of [speciesButton, detailsButton, displayButton, datasetButton]) {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
    expect(document.querySelector('.froglabel-app')).toHaveAttribute(
      'data-species-panel',
      'closed',
    );
    expect(document.querySelector('.froglabel-app')).toHaveAttribute(
      'data-inspector-panel',
      'closed',
    );
    expect(document.querySelector('.froglabel-app')).toHaveAttribute(
      'data-dataset-panel',
      'closed',
    );
    expect(screen.queryByLabelText('Species catalog panel')).not.toBeInTheDocument();

    await user.click(speciesButton);
    expect(document.querySelector('.froglabel-app')).toHaveAttribute('data-species-panel', 'open');
    expect(speciesButton).toHaveFocus();
    fireEvent.keyDown(speciesButton, { code: 'Digit2', key: '2' });
    expect(detailsButton).toHaveAttribute('aria-pressed', 'true');

    const search = screen.getByRole('textbox', { name: 'Search' });
    search.focus();
    fireEvent.keyDown(search, { code: 'Digit3', key: '3' });
    expect(displayButton).toHaveAttribute('aria-pressed', 'false');
    expect(fireEvent.keyDown(search, { code: 'KeyZ', key: 'z', ctrlKey: true })).toBe(true);

    fireEvent.pointerDown(window, { buttons: 1, pointerId: 17 });
    fireEvent.keyDown(window, { code: 'Digit4', key: '4' });
    expect(datasetButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.pointerUp(window, { buttons: 0, pointerId: 17 });
    fireEvent.keyDown(window, { code: 'Digit4', key: '4' });
    expect(datasetButton).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.froglabel-app')).toHaveAttribute('data-dataset-panel', 'open');

    fireEvent.keyDown(window, { code: 'Digit4', key: '4' });
    fireEvent.pointerDown(window, { buttons: 1, pointerId: 18 });
    fireEvent.pointerCancel(window, { buttons: 0, pointerId: 18 });
    fireEvent.keyDown(window, { code: 'Digit4', key: '4' });
    expect(datasetButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyDown(window, { code: 'Digit4', key: '4' });
    fireEvent.pointerDown(window, { buttons: 1, pointerId: 19 });
    fireEvent.lostPointerCapture(window, { buttons: 0, pointerId: 19 });
    fireEvent.keyDown(window, { code: 'Digit4', key: '4' });
    expect(datasetButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyDown(window, { code: 'Digit4', key: '4' });
    fireEvent.pointerDown(window, { buttons: 1, pointerId: 20 });
    fireEvent.blur(window);
    fireEvent.keyDown(window, { code: 'Digit4', key: '4' });
    expect(datasetButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyDown(window, { code: 'Digit4', key: '4' });
    fireEvent.pointerDown(window, { buttons: 1, pointerId: 21 });
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.keyDown(window, { code: 'Digit4', key: '4' });
    expect(datasetButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyDown(window, { code: 'Digit4', key: '4', repeat: true });
    expect(datasetButton).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { code: 'Digit4', key: '4', ctrlKey: true });
    expect(datasetButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(window, { code: 'Digit4', key: '4', altKey: true });
    expect(datasetButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows labeled large-shortcut controls, one No Calls action, and all legacy palette previews', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const shortcuts = screen.getByRole('navigation', { name: 'Workspace panels and review' });
    for (const label of ['Species', 'Box details', 'Spectrogram', 'Dataset', 'No calls']) {
      expect(within(shortcuts).getByText(label)).toBeVisible();
    }
    expect(screen.getAllByRole('button', { name: 'No calls present (Shift+X)' })).toHaveLength(1);
    expect(document.querySelector('.empty-annotation')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '3 Display' }));
    const paletteGroup = screen.getByRole('radiogroup', { name: 'Spectrogram palette' });
    const palettes = within(paletteGroup).getAllByRole('radio');
    expect(palettes).toHaveLength(7);
    for (const label of [
      'Roseus',
      'Inferno',
      'Inverse gray',
      'Gray',
      'Viridis',
      'Magma',
      'Plasma',
    ]) {
      expect(within(paletteGroup).getByRole('radio', { name: `${label} palette` })).toBeVisible();
    }
    expect(within(paletteGroup).getByRole('radio', { name: 'Viridis palette' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(paletteGroup).getByRole('radio', { name: 'Roseus palette' }));
    expect(within(paletteGroup).getByRole('radio', { name: 'Roseus palette' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByLabelText('Roseus dBFS scale')).toHaveTextContent('-120-90-60-300');

    const frequencyScale = screen.getByLabelText('Frequency scale');
    expect(within(frequencyScale).getAllByRole('option')).toHaveLength(3);
    await user.selectOptions(frequencyScale, 'adjustable');
    const emphasis = screen.getByRole('slider', { name: 'Low-frequency emphasis' });
    expect(emphasis).toHaveValue('0.5');
    fireEvent.change(emphasis, { target: { value: '0.75' } });
    expect(screen.getByText('75%')).toBeVisible();
  });

  it('resets the actual virtual species-list scroll position when filtering', async () => {
    const user = userEvent.setup();
    renderWorkspace(expertCatalog);
    await user.click(screen.getByRole('button', { name: '1 Species' }));
    const list = await screen.findByRole('listbox', { name: 'Project species' });
    const search = screen.getByRole('textbox', { name: 'Search' });

    list.scrollTop = 420;
    fireEvent.scroll(list);
    await user.type(search, 'Green');

    expect(list.scrollTop).toBe(0);
    expect(screen.getByRole('option', { name: 'GRE Green Tree Frog' })).toBeVisible();
  });

  it('previews a held-Space species prefix, masks commands, and commits Draw on release', async () => {
    const user = userEvent.setup();
    renderWorkspace(expertCatalog);
    const speciesButton = screen.getByRole('button', { name: '1 Species' });
    await user.click(speciesButton);
    await screen.findByRole('option', { name: 'GRE Green Tree Frog' });
    await user.click(speciesButton);

    const status = document.querySelector<HTMLElement>('.expert-status-line')!;
    const drawButton = screen.getByRole('button', { name: 'Draw tool (T)' });
    const selectButton = screen.getByRole('button', { name: 'Select tool (G)' });
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    expect(document.querySelector('.froglabel-app')).toHaveAttribute(
      'data-species-capture',
      'active',
    );
    fireEvent.keyDown(window, { code: 'ShiftLeft', key: 'Shift', shiftKey: true });
    expect(status).not.toHaveClass('invalid');
    expect(status).toHaveAttribute('data-species-query', '');
    fireEvent.keyDown(window, { code: 'KeyG', key: 'g' });
    expect(status).toHaveAttribute('data-species-query', 'G');
    expect(status).toHaveAttribute('data-species-candidate', 'GRE');
    expect(status).toHaveTextContent(/SPECIES G_.*GRE.*2 matches.*GRA.*release Space/i);

    fireEvent.keyDown(window, { code: 'Digit1', key: '1' });
    fireEvent.keyDown(window, { code: 'KeyT', key: 't' });
    expect(speciesButton).toHaveAttribute('aria-pressed', 'false');
    expect(drawButton).toHaveAttribute('aria-pressed', 'false');
    expect(selectButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyUp(window, { code: 'Space', key: ' ' });
    expect(document.querySelector('.froglabel-app')).toHaveAttribute(
      'data-species-capture',
      'idle',
    );
    expect(screen.getByLabelText('Current species')).toHaveTextContent('GREGreen Tree Frog');
    expect(status).toHaveTextContent(/DRAW.*GRE — Green Tree Frog/);
    expect(drawButton).toHaveAttribute('aria-pressed', 'true');
    expect(selectButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(window, { code: 'KeyG', key: 'g' });
    expect(drawButton).toHaveAttribute('aria-pressed', 'false');
    expect(selectButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('starts a Space species chord on the focused command surface but not a native button', async () => {
    const user = userEvent.setup();
    renderWorkspace(expertCatalog);
    const speciesButton = screen.getByRole('button', { name: '1 Species' });
    await user.click(speciesButton);
    await screen.findByRole('option', { name: 'GRE Green Tree Frog' });
    await user.click(speciesButton);

    // The no-audio fixture does not mount SpectrogramCanvas, so model its
    // programmatically focusable stage while exercising the real window
    // listener and target-routing guard.
    const commandSurface = document.createElement('div');
    commandSurface.className = 'spectrogram-stage';
    commandSurface.tabIndex = 0;
    commandSurface.dataset.workspaceCommandSurface = 'true';
    document.body.append(commandSurface);
    commandSurface.focus();
    fireEvent.keyDown(commandSurface, { code: 'Space', key: ' ' });
    expect(document.querySelector('.froglabel-app')).toHaveAttribute(
      'data-species-capture',
      'active',
    );
    fireEvent.keyUp(commandSurface, { code: 'Space', key: ' ' });

    const selectButton = screen.getByRole('button', { name: 'Select tool (G)' });
    selectButton.focus();
    fireEvent.keyDown(selectButton, { code: 'Space', key: ' ' });
    expect(document.querySelector('.froglabel-app')).toHaveAttribute(
      'data-species-capture',
      'idle',
    );
    commandSurface.remove();
  });

  it('cancels a held species chord when the catalog revision changes', async () => {
    const user = userEvent.setup();
    const annotation = new MemoryAnnotationDocumentPort(null);
    const species = new MemorySpeciesCatalogPort(expertCatalog);
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
        mode="demo"
      />,
    );
    await user.click(screen.getByRole('button', { name: '1 Species' }));
    const search = await screen.findByRole('textbox', { name: 'Search' });
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    fireEvent.keyDown(window, { code: 'KeyG', key: 'g' });
    expect(document.querySelector('.froglabel-app')).toHaveAttribute(
      'data-species-capture',
      'active',
    );

    await species.create({ code: 'F', speciesName: 'Fresh Catalog Frog' });
    fireEvent.focus(search);
    await waitFor(() =>
      expect(document.querySelector('.froglabel-app')).toHaveAttribute(
        'data-species-capture',
        'idle',
      ),
    );
    fireEvent.keyUp(window, { code: 'Space', key: ' ' });
    expect(screen.getByLabelText('Current species')).not.toHaveTextContent('GREGreen Tree Frog');
    expect(document.querySelector('.sr-live')).toHaveTextContent(/catalog changed/i);
  });

  it('commits a species but leaves Select armed in a read-only workspace', async () => {
    const user = userEvent.setup();
    const annotation = new MemoryAnnotationDocumentPort(null, { locked: true });
    const species = new MemorySpeciesCatalogPort(expertCatalog);
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
        mode="demo"
      />,
    );
    const drawButton = screen.getByRole('button', { name: 'Draw tool (T)' });
    const selectButton = screen.getByRole('button', { name: 'Select tool (G)' });
    const speciesButton = screen.getByRole('button', { name: '1 Species' });
    await user.click(speciesButton);
    await screen.findByRole('option', { name: 'GRE Green Tree Frog' });
    expect(screen.getByRole('button', { name: /Add missing species/ })).toBeDisabled();
    expect(screen.getByText(/cannot be added while this workspace is read-only/i)).toBeVisible();
    await user.click(speciesButton);
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    fireEvent.keyDown(window, { code: 'KeyG', key: 'g' });
    fireEvent.keyUp(window, { code: 'Space', key: ' ' });
    expect(screen.getByLabelText('Current species')).toHaveTextContent('GREGreen Tree Frog');
    expect(drawButton).toHaveAttribute('aria-pressed', 'false');
    expect(selectButton).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.sr-live')).toHaveTextContent(/Read-only/i);
  });

  it('keeps the playback button label and dimensions semantically stable', () => {
    renderWorkspace();
    const play = screen.getByRole('button', { name: 'Play or pause audio (V)' });
    expect(play).toHaveTextContent(/^Play V$/);
    expect(play).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(/^Pause$/)).not.toBeInTheDocument();
  });

  it('advances the tutorial with Enter, reserves Space, and teaches the GRE chord', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(screen.getByRole('button', { name: 'Help and tutorial' }));
    await user.click(screen.getByRole('button', { name: /Start 2-minute tutorial/ }));
    const nextButton = screen.getByRole('button', { name: /^Next/ });
    nextButton.focus();
    fireEvent.keyDown(nextButton, { code: 'Space', key: ' ' });
    expect(screen.getByRole('dialog', { name: 'Tutorial step 1 of 12' })).toBeVisible();
    expect(document.querySelector('.tutorial-practice-layer .froglabel-app')).toHaveAttribute(
      'data-species-capture',
      'idle',
    );
    fireEvent.keyUp(nextButton, { code: 'Space', key: ' ' });
    fireEvent.keyDown(nextButton, { code: 'Enter', key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Tutorial step 1 of 12' })).toBeVisible();
    fireEvent.keyDown(window, { code: 'Enter', key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Tutorial step 2 of 12' })).toBeVisible();
    fireEvent.keyDown(window, { code: 'Enter', key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Tutorial step 3 of 12' })).toBeVisible();
    expect(screen.getByText('Choose GRE')).toBeVisible();
    expect(screen.getByText(/Hold Space, tap G, then release Space to choose GRE/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Exit tutorial/ }));
    expect(screen.queryByRole('dialog', { name: /Tutorial step/ })).not.toBeInTheDocument();
  });
});
