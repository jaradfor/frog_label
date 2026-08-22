import type {
  AudioBounds,
  FrogLabelBoxV1,
  FrogLabelDocumentV1,
  PixelPoint,
  SpeciesEntryV1,
  ViewportTransform,
} from './types';
import { assertDocument, speciesSnapshot } from './validation';
import {
  cloneDocument,
  createHumanBox,
  deterministicSerialize,
  noCallsDocument,
  sortBoxes,
} from './document';
import { geometryFromDrag } from './projection';
import { ValidationError } from './errors';

export interface GesturePreview {
  kind: 'draw' | 'resize';
  boxId?: string;
  handle?: 'nw' | 'ne' | 'sw' | 'se';
  start: PixelPoint;
  current: PixelPoint;
  viewport: ViewportTransform;
}

export interface DomainState {
  epoch: number;
  catalogId: string;
  bounds: AudioBounds;
  document: FrogLabelDocumentV1 | null;
  selectedBoxId: string | null;
  preview: GesturePreview | null;
  undo: Array<FrogLabelDocumentV1 | null>;
  redo: Array<FrogLabelDocumentV1 | null>;
  revision: number;
  lastEvent: string | null;
}

export type DomainCommand =
  | {
      type: 'context/replace';
      epoch: number;
      catalogId: string;
      bounds: AudioBounds;
      document: FrogLabelDocumentV1 | null;
    }
  | {
      type: 'box/createCommitted';
      species: SpeciesEntryV1;
      geometry: Pick<
        FrogLabelBoxV1,
        'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
      >;
      id: string;
      timestamp: string;
    }
  | {
      type: 'box/resizeCommitted';
      boxId: string;
      geometry: Pick<
        FrogLabelBoxV1,
        'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
      >;
      timestamp: string;
    }
  | { type: 'box/delete'; boxId: string }
  | { type: 'box/select'; boxId: string | null }
  | { type: 'species/assign'; boxId: string; species: SpeciesEntryV1; timestamp: string }
  | { type: 'review/setNoCalls' }
  | { type: 'review/clear' }
  | { type: 'gesture/start'; preview: GesturePreview }
  | { type: 'gesture/update'; point: PixelPoint }
  | { type: 'gesture/cancel' }
  | { type: 'gesture/commit'; species?: SpeciesEntryV1; id?: string; timestamp: string }
  | { type: 'history/undo' }
  | { type: 'history/redo' };

export function initialDomainState(catalogId: string, bounds: AudioBounds): DomainState {
  return {
    epoch: 0,
    catalogId,
    bounds,
    document: null,
    selectedBoxId: null,
    preview: null,
    undo: [],
    redo: [],
    revision: 0,
    lastEvent: null,
  };
}

function commitDocument(
  state: DomainState,
  next: FrogLabelDocumentV1 | null,
  event: string,
  selectedBoxId = state.selectedBoxId,
): DomainState {
  // Command constructors validate new documents before this boundary. Domain
  // states are immutable, so retaining structural references for history avoids
  // cloning and canonicalizing every box during a large-document gesture.
  return {
    ...state,
    document: next,
    selectedBoxId,
    preview: null,
    undo: [...state.undo, state.document].slice(-100),
    redo: [],
    revision: state.revision + 1,
    lastEvent: event,
  };
}

function boxes(state: DomainState): FrogLabelBoxV1[] {
  return state.document?.boxes ?? [];
}

export function domainReducer(state: DomainState, command: DomainCommand): DomainState {
  switch (command.type) {
    case 'context/replace': {
      if (command.document) assertDocument(command.document, command.bounds);
      return {
        ...initialDomainState(command.catalogId, command.bounds),
        epoch: command.epoch,
        document: cloneDocument(command.document),
        revision: state.revision + 1,
        lastEvent: 'context.replaced',
      };
    }
    case 'box/select':
      if (command.boxId && !boxes(state).some((box) => box.id === command.boxId)) return state;
      return { ...state, selectedBoxId: command.boxId, lastEvent: 'box.selected' };
    case 'box/createCommitted': {
      const box = createHumanBox(
        command.species,
        normalizeGeometry(command.geometry, state.bounds),
        command.id,
        command.timestamp,
      );
      const next = documentFromTrustedBoxes(state.catalogId, [...boxes(state), box]);
      return commitDocument(state, next, 'box.created', box.id);
    }
    case 'box/resizeCommitted': {
      const existing = boxes(state).find((box) => box.id === command.boxId);
      if (!existing) throw new ValidationError('Cannot resize a missing box', command.boxId);
      const geometry = normalizeGeometry(command.geometry, state.bounds);
      const nextBoxes = boxes(state).map((box) =>
        box.id === command.boxId
          ? {
              ...box,
              ...geometry,
              updatedAt: command.timestamp,
              provenance: markHumanModified(box.provenance),
            }
          : box,
      );
      return commitDocument(
        state,
        documentFromTrustedBoxes(state.catalogId, nextBoxes),
        'box.resized',
        command.boxId,
      );
    }
    case 'box/delete': {
      const nextBoxes = boxes(state).filter((box) => box.id !== command.boxId);
      if (nextBoxes.length === boxes(state).length) return state;
      return commitDocument(
        state,
        documentFromTrustedBoxes(state.catalogId, nextBoxes),
        'box.deleted',
        state.selectedBoxId === command.boxId ? null : state.selectedBoxId,
      );
    }
    case 'species/assign': {
      const nextBoxes = boxes(state).map((box) =>
        box.id === command.boxId
          ? {
              ...box,
              species: speciesSnapshot(command.species),
              updatedAt: command.timestamp,
              provenance: markHumanModified(box.provenance),
            }
          : box,
      );
      if (!nextBoxes.some((box) => box.id === command.boxId)) return state;
      return commitDocument(
        state,
        documentFromTrustedBoxes(state.catalogId, nextBoxes),
        'species.assigned',
        command.boxId,
      );
    }
    case 'review/setNoCalls':
      if (state.document?.reviewStatus === 'no_calls') return state;
      return commitDocument(state, noCallsDocument(state.catalogId), 'review.no_calls', null);
    case 'review/clear':
      return state.document?.reviewStatus === 'no_calls'
        ? commitDocument(state, null, 'review.cleared', null)
        : state;
    case 'gesture/start':
      return { ...state, preview: structuredClone(command.preview), lastEvent: 'gesture.started' };
    case 'gesture/update':
      return state.preview
        ? {
            ...state,
            preview: { ...state.preview, current: command.point },
            lastEvent: 'gesture.previewed',
          }
        : state;
    case 'gesture/cancel':
      return state.preview ? { ...state, preview: null, lastEvent: 'gesture.cancelled' } : state;
    case 'gesture/commit': {
      if (!state.preview) return state;
      const geometry = geometryFromDrag(
        state.preview.start,
        state.preview.current,
        state.preview.viewport,
      );
      if (state.preview.kind === 'draw') {
        if (!command.species)
          throw new ValidationError('Select a species before drawing a new box');
        if (!command.id) throw new ValidationError('Draw gesture is missing a box ID');
        return domainReducer(
          { ...state, preview: null },
          {
            type: 'box/createCommitted',
            species: command.species,
            geometry,
            id: command.id,
            timestamp: command.timestamp,
          },
        );
      }
      if (!state.preview.boxId) throw new ValidationError('Resize gesture is missing a box ID');
      return domainReducer(
        { ...state, preview: null },
        {
          type: 'box/resizeCommitted',
          boxId: state.preview.boxId,
          geometry,
          timestamp: command.timestamp,
        },
      );
    }
    case 'history/undo': {
      if (state.undo.length === 0) return state;
      const previous = state.undo[state.undo.length - 1];
      return {
        ...state,
        document: previous,
        selectedBoxId: null,
        preview: null,
        undo: state.undo.slice(0, -1),
        redo: [state.document, ...state.redo].slice(0, 100),
        revision: state.revision + 1,
        lastEvent: 'history.undone',
      };
    }
    case 'history/redo': {
      if (state.redo.length === 0) return state;
      const next = state.redo[0];
      return {
        ...state,
        document: next,
        selectedBoxId: null,
        preview: null,
        undo: [...state.undo, state.document].slice(-100),
        redo: state.redo.slice(1),
        revision: state.revision + 1,
        lastEvent: 'history.redone',
      };
    }
    default:
      return state;
  }
}

export function boxesDeepEqual(
  left: FrogLabelDocumentV1 | null,
  right: FrogLabelDocumentV1 | null,
) {
  return deterministicSerialize(left) === deterministicSerialize(right);
}

function documentFromTrustedBoxes(
  catalogId: string,
  boxes: readonly FrogLabelBoxV1[],
): FrogLabelDocumentV1 | null {
  if (boxes.length === 0) return null;
  if (boxes.length > 5_000) {
    throw new ValidationError('Annotation exceeds the 5000-box POC limit');
  }
  // The prior state has already passed full schema validation. Reducer
  // commands preserve every untouched box and validate only the field they
  // change, so rescanning thousands of immutable boxes on each pointer-up is
  // redundant. Untrusted port/schema boundaries still perform full validation.
  return {
    kind: 'froglabel.annotation-set',
    schemaVersion: 1,
    catalogId,
    reviewStatus: 'calls_present',
    boxes: sortBoxes(boxes),
  };
}

function normalizeGeometry(
  geometry: Pick<
    FrogLabelBoxV1,
    'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
  >,
  bounds: AudioBounds,
): Pick<
  FrogLabelBoxV1,
  'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
> {
  const values = [
    geometry.startTimeSeconds,
    geometry.endTimeSeconds,
    geometry.lowFrequencyHz,
    geometry.highFrequencyHz,
  ];
  if (!values.every(Number.isFinite)) throw new ValidationError('Box coordinates must be finite');
  const clamp = (value: number, maximum: number) => Math.min(maximum, Math.max(0, value));
  const firstTime = clamp(geometry.startTimeSeconds, bounds.durationSeconds);
  const secondTime = clamp(geometry.endTimeSeconds, bounds.durationSeconds);
  const firstFrequency = clamp(geometry.lowFrequencyHz, bounds.maximumFrequencyHz);
  const secondFrequency = clamp(geometry.highFrequencyHz, bounds.maximumFrequencyHz);
  const normalized = {
    startTimeSeconds: Math.min(firstTime, secondTime),
    endTimeSeconds: Math.max(firstTime, secondTime),
    lowFrequencyHz: Math.min(firstFrequency, secondFrequency),
    highFrequencyHz: Math.max(firstFrequency, secondFrequency),
  };
  if (
    normalized.startTimeSeconds >= normalized.endTimeSeconds ||
    normalized.lowFrequencyHz >= normalized.highFrequencyHz
  ) {
    throw new ValidationError('A committed box must have positive duration and bandwidth');
  }
  return normalized;
}

function markHumanModified(provenance: FrogLabelBoxV1['provenance']): FrogLabelBoxV1['provenance'] {
  return provenance.source === 'model' ? { ...provenance, humanModified: true } : provenance;
}
