import { describe, expect, it } from 'vitest';
import {
  commandForKeyboardEvent,
  isEditableTarget,
  isNativeControlTarget,
  isPanelCommand,
  isRepeatableCommand,
  speciesCharacterForCode,
  speciesCharacterForKeyboardEvent,
  type WorkspaceCommandId,
  type WorkspaceKeyboardRoutingContext,
} from '../../src/app/keyboard';

function route(
  init: KeyboardEventInit,
  target: HTMLElement = document.body,
  context?: WorkspaceKeyboardRoutingContext,
): WorkspaceCommandId | null {
  let command: WorkspaceCommandId | null = null;
  const listener = (event: KeyboardEvent) => {
    command = commandForKeyboardEvent(event, context);
  };
  target.addEventListener('keydown', listener, { once: true });
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  return command;
}

describe('expert workspace keyboard routing', () => {
  it.each([
    ['Digit1', false, 'panel.species'],
    ['Digit2', false, 'panel.details'],
    ['Digit3', false, 'panel.display'],
    ['Digit4', false, 'panel.dataset'],
    ['KeyW', false, 'viewport.panUp'],
    ['KeyS', false, 'viewport.panDown'],
    ['KeyA', false, 'viewport.panLeft'],
    ['KeyD', false, 'viewport.panRight'],
    ['KeyQ', false, 'viewport.zoomOut'],
    ['KeyE', false, 'viewport.zoomIn'],
    ['KeyD', true, 'viewport.zoomTimeIn'],
    ['KeyA', true, 'viewport.zoomTimeOut'],
    ['KeyW', true, 'viewport.zoomFrequencyIn'],
    ['KeyS', true, 'viewport.zoomFrequencyOut'],
    ['KeyX', false, 'viewport.fit'],
    ['KeyV', false, 'audio.playPause'],
    ['KeyV', true, 'audio.toggleFollow'],
    ['KeyF', false, 'audio.faster'],
    ['KeyR', false, 'audio.slower'],
    ['KeyT', false, 'tool.draw'],
    ['KeyG', false, 'tool.select'],
    ['KeyR', true, 'box.delete'],
    ['Tab', false, 'selection.nextBox'],
    ['Tab', true, 'selection.previousBox'],
    ['KeyC', false, 'selection.cycleForward'],
    ['KeyC', true, 'selection.cycleBackward'],
    ['KeyX', true, 'review.noCalls'],
    ['Escape', false, 'gesture.cancel'],
  ] as const)('maps physical %s (shift=%s) to %s', (code, shiftKey, expected) => {
    expect(route({ code, shiftKey })).toBe(expected);
  });

  it('routes platform undo and redo while leaving other modified keys to the host', () => {
    expect(route({ code: 'KeyZ', ctrlKey: true })).toBe('history.undo');
    expect(route({ code: 'KeyZ', metaKey: true, shiftKey: true })).toBe('history.redo');
    expect(route({ code: 'KeyY', ctrlKey: true })).toBe('history.redo');
    expect(route({ code: 'KeyD', ctrlKey: true })).toBeNull();
    expect(route({ code: 'KeyD', altKey: true })).toBeNull();
  });

  it('keeps numbered drawers modifier-insensitive outside fields and pointer gestures', () => {
    expect(route({ code: 'Digit1', ctrlKey: true })).toBe('panel.species');
    expect(route({ code: 'Digit2', metaKey: true })).toBe('panel.details');
    expect(route({ code: 'Digit3', altKey: true })).toBe('panel.display');
    expect(route({ code: 'Digit4', shiftKey: true })).toBe('panel.dataset');
  });

  it('allows repeat only for continuous pan and zoom commands', () => {
    expect(route({ code: 'KeyW', repeat: true })).toBe('viewport.panUp');
    expect(route({ code: 'KeyE', repeat: true })).toBe('viewport.zoomIn');
    expect(route({ code: 'KeyD', shiftKey: true, repeat: true })).toBe('viewport.zoomTimeIn');
    expect(route({ code: 'KeyW', shiftKey: true, repeat: true })).toBe('viewport.zoomFrequencyIn');
    expect(route({ code: 'KeyX', repeat: true })).toBeNull();
    expect(route({ code: 'KeyV', repeat: true })).toBeNull();
    expect(route({ code: 'KeyV', shiftKey: true, repeat: true })).toBeNull();
    expect(isRepeatableCommand('viewport.panRight')).toBe(true);
    expect(isRepeatableCommand('viewport.zoomFrequencyOut')).toBe(true);
    expect(isRepeatableCommand('audio.playPause')).toBe(false);
    expect(isRepeatableCommand('audio.toggleFollow')).toBe(false);
  });

  it('suppresses fields but not focused buttons or form containers', () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    const button = document.createElement('button');
    form.append(input, button);
    document.body.append(form);

    expect(route({ code: 'Digit1' }, input)).toBeNull();
    expect(route({ code: 'Digit1' }, button)).toBe('panel.species');
    expect(route({ code: 'Digit1' }, form)).toBe('panel.species');
    expect(route({ code: 'Escape' }, input)).toBe('gesture.cancel');
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(button)).toBe(false);
    expect(isEditableTarget(form)).toBe(false);

    form.remove();
  });

  it('cycles boxes with Tab only from body or the marked command surface', () => {
    const surface = document.createElement('div');
    surface.tabIndex = 0;
    surface.dataset.workspaceCommandSurface = 'true';
    const button = document.createElement('button');
    surface.append(button);
    document.body.append(surface);

    expect(route({ code: 'Tab' })).toBe('selection.nextBox');
    expect(route({ code: 'Tab', shiftKey: true }, surface)).toBe('selection.previousBox');
    expect(route({ code: 'Tab' }, button)).toBeNull();
    expect(isNativeControlTarget(button)).toBe(true);
    expect(isNativeControlTarget(surface)).toBe(true);

    surface.remove();
  });

  it('recognizes editable descendants and contenteditable=false boundaries', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editable.append(child);
    document.body.append(editable);

    const inert = document.createElement('div');
    inert.setAttribute('contenteditable', 'false');
    document.body.append(inert);

    expect(isEditableTarget(child)).toBe(true);
    expect(route({ code: 'Digit2' }, child)).toBeNull();
    expect(isEditableTarget(inert)).toBe(false);

    editable.remove();
    inert.remove();
  });

  it('gates only drawer commands while a pointer button is held', () => {
    expect(route({ code: 'Digit1' }, document.body, { pointerButtonsHeld: true })).toBeNull();
    expect(route({ code: 'KeyV' }, document.body, { pointerButtonsHeld: true })).toBe(
      'audio.playPause',
    );
    expect(isPanelCommand('panel.dataset')).toBe(true);
    expect(isPanelCommand('viewport.zoomIn')).toBe(false);
  });

  it('masks ordinary commands during a species chord', () => {
    expect(route({ code: 'Digit1' }, document.body, { speciesCaptureActive: true })).toBeNull();
    expect(route({ code: 'KeyV' }, document.body, { speciesCaptureActive: true })).toBeNull();
    expect(route({ code: 'KeyG' }, document.body, { speciesCaptureActive: true })).toBeNull();
  });
});

describe('physical species-chord keys', () => {
  it('maps only the approved left-side physical positions', () => {
    expect(speciesCharacterForCode('KeyQ')).toBe('Q');
    expect(speciesCharacterForCode('KeyB')).toBe('B');
    expect(speciesCharacterForCode('KeyH')).toBeNull();
    expect(speciesCharacterForCode('Digit6')).toBeNull();
  });

  it('ignores repeats, composition, and operating-system modifiers', () => {
    expect(speciesCharacterForKeyboardEvent(new KeyboardEvent('keydown', { code: 'KeyG' }))).toBe(
      'G',
    );
    expect(
      speciesCharacterForKeyboardEvent(
        new KeyboardEvent('keydown', { code: 'KeyG', repeat: true }),
      ),
    ).toBeNull();
    expect(
      speciesCharacterForKeyboardEvent(
        new KeyboardEvent('keydown', { code: 'KeyG', ctrlKey: true }),
      ),
    ).toBeNull();
  });
});
