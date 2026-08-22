export type WorkspaceCommandId =
  | 'panel.species'
  | 'panel.details'
  | 'panel.display'
  | 'panel.dataset'
  | 'tool.draw'
  | 'tool.select'
  | 'tool.pan'
  | 'audio.playPause'
  | 'audio.faster'
  | 'audio.slower'
  | 'viewport.zoomIn'
  | 'viewport.zoomOut'
  | 'box.delete'
  | 'selection.cycleForward'
  | 'selection.cycleBackward'
  | 'review.noCalls'
  | 'gesture.cancel'
  | 'history.undo'
  | 'history.redo';

export interface WorkspaceCommandDefinition {
  id: WorkspaceCommandId;
  label: string;
  shortcut: string;
  code?: string;
  shift?: boolean;
}

export const WORKSPACE_COMMANDS: readonly WorkspaceCommandDefinition[] = [
  { id: 'panel.species', label: 'Toggle Species', shortcut: '1', code: 'Digit1' },
  { id: 'panel.details', label: 'Toggle Details', shortcut: '2', code: 'Digit2' },
  { id: 'panel.display', label: 'Toggle Spectrogram', shortcut: '3', code: 'Digit3' },
  { id: 'panel.dataset', label: 'Toggle Dataset', shortcut: '4', code: 'Digit4' },
  { id: 'tool.draw', label: 'Draw Box', shortcut: 'D', code: 'KeyD' },
  { id: 'tool.select', label: 'Select', shortcut: 'V', code: 'KeyV' },
  { id: 'tool.pan', label: 'Pan', shortcut: 'P', code: 'KeyP' },
  { id: 'audio.playPause', label: 'Play or pause', shortcut: 'Space', code: 'Space' },
  { id: 'audio.faster', label: 'Faster playback', shortcut: '>', code: 'Period', shift: true },
  { id: 'audio.slower', label: 'Slower playback', shortcut: '<', code: 'Comma', shift: true },
  { id: 'viewport.zoomIn', label: 'Zoom in', shortcut: '+', code: 'Equal' },
  { id: 'viewport.zoomOut', label: 'Zoom out', shortcut: '−', code: 'Minus' },
  { id: 'box.delete', label: 'Delete selected box', shortcut: 'Delete', code: 'Delete' },
  {
    id: 'selection.cycleForward',
    label: 'Next overlapping box',
    shortcut: ']',
    code: 'BracketRight',
  },
  {
    id: 'selection.cycleBackward',
    label: 'Previous overlapping box',
    shortcut: '[',
    code: 'BracketLeft',
  },
  {
    id: 'review.noCalls',
    label: 'No calls present',
    shortcut: 'Shift+N',
    code: 'KeyN',
    shift: true,
  },
  { id: 'gesture.cancel', label: 'Cancel', shortcut: 'Escape', code: 'Escape' },
] as const;

const byCode = new Map(
  WORKSPACE_COMMANDS.filter((command) => command.code).map((command) => [
    `${command.shift === true}:${command.code}`,
    command.id,
  ]),
);

export function commandForKeyboardEvent(event: KeyboardEvent): WorkspaceCommandId | null {
  if (event.repeat || event.isComposing || event.altKey) return null;
  // Native editing history belongs to the focused form control. Keep this guard
  // before the workspace Ctrl/Cmd+Z dispatcher so typing in species/search and
  // geometry fields can always use the browser's own undo/redo behavior.
  if (event.code !== 'Escape' && isEditableTarget(event.target)) return null;
  if (event.ctrlKey || event.metaKey) {
    if (event.altKey || event.code !== 'KeyZ') {
      if (!event.shiftKey && event.code === 'KeyY') return 'history.redo';
      return null;
    }
    return event.shiftKey ? 'history.redo' : 'history.undo';
  }
  return byCode.get(`${event.shiftKey}:${event.code}`) ?? null;
}

export function commandDefinition(id: WorkspaceCommandId): WorkspaceCommandDefinition {
  const command = WORKSPACE_COMMANDS.find((candidate) => candidate.id === id);
  if (!command) throw new Error(`Unknown workspace command ${id}`);
  return command;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.matches('input, textarea, select, button, [contenteditable="true"]') ||
    Boolean(target.closest('form, [contenteditable="true"]'))
  );
}
