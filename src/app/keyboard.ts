export type WorkspaceCommandId =
  | 'panel.species'
  | 'panel.details'
  | 'panel.display'
  | 'panel.dataset'
  | 'viewport.panUp'
  | 'viewport.panDown'
  | 'viewport.panLeft'
  | 'viewport.panRight'
  | 'viewport.zoomIn'
  | 'viewport.zoomOut'
  | 'viewport.zoomTimeIn'
  | 'viewport.zoomTimeOut'
  | 'viewport.zoomFrequencyIn'
  | 'viewport.zoomFrequencyOut'
  | 'viewport.fit'
  | 'audio.playPause'
  | 'audio.faster'
  | 'audio.slower'
  | 'tool.toggleDrawSelect'
  | 'box.delete'
  | 'selection.nextBox'
  | 'selection.previousBox'
  | 'selection.cycleForward'
  | 'selection.cycleBackward'
  | 'review.noCalls'
  | 'gesture.cancel'
  | 'history.undo'
  | 'history.redo'
  // These commands remain available to pointer-driven toolbar controls. They
  // intentionally have no keyboard binding in the expert command map.
  | 'tool.draw'
  | 'tool.select'
  | 'tool.pan';

export interface WorkspaceCommandDefinition {
  id: WorkspaceCommandId;
  label: string;
  shortcut: string;
  code: string;
  shift?: boolean;
  /** Displayed in help but routed by the platform-aware history handler. */
  primaryModifier?: boolean;
  repeatable?: boolean;
}

export interface WorkspaceKeyboardRoutingContext {
  /** True while at least one pointer button is down anywhere in the workspace. */
  pointerButtonsHeld?: boolean;
  /** All ordinary commands are masked while the Space species chord is active. */
  speciesCaptureActive?: boolean;
}

export const WORKSPACE_COMMANDS: readonly WorkspaceCommandDefinition[] = [
  { id: 'panel.species', label: 'Toggle Species', shortcut: '1', code: 'Digit1' },
  { id: 'panel.details', label: 'Toggle Details', shortcut: '2', code: 'Digit2' },
  { id: 'panel.display', label: 'Toggle Spectrogram', shortcut: '3', code: 'Digit3' },
  { id: 'panel.dataset', label: 'Toggle Dataset', shortcut: '4', code: 'Digit4' },
  {
    id: 'viewport.panUp',
    label: 'Pan frequency up',
    shortcut: 'W',
    code: 'KeyW',
    repeatable: true,
  },
  {
    id: 'viewport.panDown',
    label: 'Pan frequency down',
    shortcut: 'S',
    code: 'KeyS',
    repeatable: true,
  },
  {
    id: 'viewport.panLeft',
    label: 'Pan earlier',
    shortcut: 'A',
    code: 'KeyA',
    repeatable: true,
  },
  {
    id: 'viewport.panRight',
    label: 'Pan later',
    shortcut: 'D',
    code: 'KeyD',
    repeatable: true,
  },
  {
    id: 'viewport.zoomIn',
    label: 'Zoom both axes in',
    shortcut: 'Q',
    code: 'KeyQ',
    repeatable: true,
  },
  {
    id: 'viewport.zoomOut',
    label: 'Zoom both axes out',
    shortcut: 'E',
    code: 'KeyE',
    repeatable: true,
  },
  {
    id: 'viewport.zoomTimeIn',
    label: 'Zoom time in',
    shortcut: 'Shift+A',
    code: 'KeyA',
    shift: true,
    repeatable: true,
  },
  {
    id: 'viewport.zoomTimeOut',
    label: 'Zoom time out',
    shortcut: 'Shift+D',
    code: 'KeyD',
    shift: true,
    repeatable: true,
  },
  {
    id: 'viewport.zoomFrequencyIn',
    label: 'Zoom frequency in',
    shortcut: 'Shift+W',
    code: 'KeyW',
    shift: true,
    repeatable: true,
  },
  {
    id: 'viewport.zoomFrequencyOut',
    label: 'Zoom frequency out',
    shortcut: 'Shift+S',
    code: 'KeyS',
    shift: true,
    repeatable: true,
  },
  { id: 'viewport.fit', label: 'Fit complete recording', shortcut: 'X', code: 'KeyX' },
  { id: 'audio.playPause', label: 'Play or pause', shortcut: 'V', code: 'KeyV' },
  { id: 'audio.faster', label: 'Faster playback', shortcut: 'F', code: 'KeyF' },
  { id: 'audio.slower', label: 'Slower playback', shortcut: 'R', code: 'KeyR' },
  {
    id: 'tool.toggleDrawSelect',
    label: 'Toggle Select or Draw',
    shortcut: 'T',
    code: 'KeyT',
  },
  {
    id: 'box.delete',
    label: 'Delete selected box',
    shortcut: 'Shift+R',
    code: 'KeyR',
    shift: true,
  },
  {
    id: 'selection.nextBox',
    label: 'Select next box',
    shortcut: 'Tab',
    code: 'Tab',
  },
  {
    id: 'selection.previousBox',
    label: 'Select previous box',
    shortcut: 'Shift+Tab',
    code: 'Tab',
    shift: true,
  },
  {
    id: 'selection.cycleForward',
    label: 'Next overlapping box',
    shortcut: 'C',
    code: 'KeyC',
  },
  {
    id: 'selection.cycleBackward',
    label: 'Previous overlapping box',
    shortcut: 'Shift+C',
    code: 'KeyC',
    shift: true,
  },
  {
    id: 'review.noCalls',
    label: 'No calls present',
    shortcut: 'Shift+X',
    code: 'KeyX',
    shift: true,
  },
  {
    id: 'history.undo',
    label: 'Undo annotation edit',
    shortcut: 'Ctrl/Cmd+Z',
    code: 'KeyZ',
    primaryModifier: true,
  },
  {
    id: 'history.redo',
    label: 'Redo annotation edit',
    shortcut: 'Ctrl/Cmd+Shift+Z',
    code: 'KeyZ',
    shift: true,
    primaryModifier: true,
  },
  { id: 'gesture.cancel', label: 'Cancel', shortcut: 'Escape', code: 'Escape' },
] as const;

const byCode = new Map(
  WORKSPACE_COMMANDS.filter((command) => !('primaryModifier' in command)).map((command) => [
    keyboardLookupKey(command.code, command.shift === true),
    command.id,
  ]),
);

const panelCommands = new Set<WorkspaceCommandId>([
  'panel.species',
  'panel.details',
  'panel.display',
  'panel.dataset',
]);

const repeatableCommands = new Set<WorkspaceCommandId>(
  WORKSPACE_COMMANDS.filter((command) => command.repeatable).map((command) => command.id),
);

const leftHandSpeciesCharactersByCode = new Map<string, string>(
  [...'QWERTASDFGZXCVB'].map((character) => [`Key${character}`, character]),
);

export function commandForKeyboardEvent(
  event: KeyboardEvent,
  context: WorkspaceKeyboardRoutingContext = {},
): WorkspaceCommandId | null {
  if (event.isComposing || context.speciesCaptureActive) return null;

  // Number drawers are deliberately modifier-insensitive. Expert operators
  // must be able to recover the side panels even after a browser/host command
  // leaves a modifier latched; fields and held pointer buttons are the only
  // contextual routing guards (repeat still cannot oscillate a drawer).
  const panelCommand = byCode.get(keyboardLookupKey(event.code, false)) ?? null;
  if (panelCommand && isPanelCommand(panelCommand)) {
    return shouldRouteWorkspaceCommand(event, panelCommand, context) ? panelCommand : null;
  }

  if (event.altKey) return null;

  const historyCommand = historyCommandForKeyboardEvent(event);
  if (historyCommand) {
    return shouldRouteWorkspaceCommand(event, historyCommand, context) ? historyCommand : null;
  }

  // Ctrl/Cmd combinations other than undo and redo remain browser/host commands.
  if (event.ctrlKey || event.metaKey) return null;

  const command = byCode.get(keyboardLookupKey(event.code, event.shiftKey)) ?? null;
  if (!command || !shouldRouteWorkspaceCommand(event, command, context)) return null;
  return command;
}

export function shouldRouteWorkspaceCommand(
  event: KeyboardEvent,
  command: WorkspaceCommandId,
  context: WorkspaceKeyboardRoutingContext = {},
): boolean {
  if (event.isComposing || context.speciesCaptureActive) return false;
  if (event.altKey && !isPanelCommand(command)) return false;
  if (event.repeat && !isRepeatableCommand(command)) return false;
  if (command !== 'gesture.cancel' && isEditableTarget(event.target)) return false;
  if (context.pointerButtonsHeld && isPanelCommand(command)) return false;
  if (
    (command === 'selection.nextBox' || command === 'selection.previousBox') &&
    !isWorkspaceCommandSurfaceTarget(event.target)
  ) {
    return false;
  }
  return true;
}

export function isPanelCommand(command: WorkspaceCommandId): boolean {
  return panelCommands.has(command);
}

export function isRepeatableCommand(command: WorkspaceCommandId): boolean {
  return repeatableCommands.has(command);
}

export function commandDefinition(id: WorkspaceCommandId): WorkspaceCommandDefinition {
  const command = WORKSPACE_COMMANDS.find((candidate) => candidate.id === id);
  if (!command) throw new Error(`Command ${id} does not have a keyboard binding`);
  return command;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  if (!element) return false;
  return Boolean(
    element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'),
  );
}

/** Native controls retain browser Tab navigation even though other shortcuts work on buttons. */
export function isNativeControlTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  if (!element) return false;
  return Boolean(
    element.closest(
      [
        'a[href]',
        'audio[controls]',
        'button',
        'details > summary',
        'iframe',
        'input',
        'select',
        'textarea',
        'video[controls]',
        '[contenteditable]:not([contenteditable="false"])',
        '[tabindex]:not([tabindex="-1"])',
      ].join(', '),
    ),
  );
}

/**
 * Tab cycles annotations only from neutral body focus or the explicitly marked
 * command surface. Add `data-workspace-command-surface` to the focusable stage.
 */
export function isWorkspaceCommandSurfaceTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  if (!element) return false;
  if (element === element.ownerDocument.body) return true;
  if (isNativeControlTarget(element)) {
    return element.matches('[data-workspace-command-surface]');
  }
  return Boolean(element.closest('[data-workspace-command-surface]'));
}

/** Map a physical QWERTY key position to the species chord character. */
export function speciesCharacterForCode(code: string): string | null {
  return leftHandSpeciesCharactersByCode.get(code) ?? null;
}

/**
 * Return one character for an eligible species-chord keydown. Repeats and
 * browser/OS modifier chords are ignored so a held key cannot duplicate input.
 */
export function speciesCharacterForKeyboardEvent(event: KeyboardEvent): string | null {
  if (event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
    return null;
  }
  return speciesCharacterForCode(event.code);
}

function historyCommandForKeyboardEvent(event: KeyboardEvent): WorkspaceCommandId | null {
  if (!(event.ctrlKey || event.metaKey) || (event.ctrlKey && event.metaKey)) return null;
  if (event.code === 'KeyZ') return event.shiftKey ? 'history.redo' : 'history.undo';
  if (event.ctrlKey && !event.shiftKey && event.code === 'KeyY') return 'history.redo';
  return null;
}

function keyboardLookupKey(code: string, shift: boolean): string {
  return `${shift}:${code}`;
}

function eventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}
