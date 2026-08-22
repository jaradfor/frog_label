import { AudioOutlined } from '@ant-design/icons';
import { reaction } from 'mobx';
import { getRoot, types } from 'mobx-state-tree';
import { observer } from 'mobx-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import Registry from '../../core/Registry';
import { AreaMixin } from '../../mixins/AreaMixin';
import { AnnotationMixin } from '../../mixins/AnnotationMixin';
import RegionsMixin from '../../mixins/Regions';
import ControlBase from '../../tags/control/Base';
import { parseValue } from '../../utils/data';

const ReactCodeAttrs = types.model({
  data: types.maybeNull(types.string),
  src: types.optional(types.string, ''),
  value: types.optional(types.string, ''),
  style: types.maybeNull(types.string),
  allow: types.optional(types.string, ''),
  outputs: types.maybeNull(types.string),
  toname: types.optional(types.string, ''),
  type: types.optional(types.literal('reactcode'), 'reactcode'),
});

export const ReactCodeModel = types
  .compose('ReactCodeModel', ControlBase, ReactCodeAttrs, AnnotationMixin)
  .volatile(() => ({
    isObjectTag: true,
    supportSuggestions: false,
  }))
  .views((self) => ({
    get resultType() {
      return 'reactcode';
    },
    get valueType() {
      return 'reactcode';
    },
    get resolvedData() {
      const taskData = getRoot(self)?.task?.dataObj ?? null;
      return self.data ? parseValue(self.data, taskData ?? {}) : taskData;
    },
    get loadedData() {
      return self.resolvedData;
    },
    get dimensions() {
      return outputDimensions(self.outputs);
    },
    get regs() {
      return matchingResults(self).map((result) => result.area);
    },
    states() {
      return [];
    },
    activeStates() {
      return [];
    },
  }));

const ReactCodeRegionModel = types
  .compose(
    'ReactCodeRegionModel',
    RegionsMixin,
    AreaMixin,
    types.model({
      object: types.late(() => types.reference(ReactCodeModel)),
    }),
  )
  .views((self) => ({
    // This tag references itself, so the stock parent/result read-only walk cycles.
    isReadOnly() {
      return Boolean(self.locked || self.readonly || self.annotation?.isReadOnly());
    },
    get type() {
      return 'reactcode';
    },
    get parent() {
      return self.object;
    },
    get values() {
      const document = self.results.find((result) => result.type === 'reactcode')?.mainValue;
      return [documentSummary(document)];
    },
  }))
  .actions(() => ({
    serialize: () => ({}),
  }));

ReactCodeRegionModel.nodeView = {
  name: 'FrogLabel',
  icon: AudioOutlined,
};

function matchingResults(item) {
  return (item.annotation?.results ?? []).filter(
    (result) => result.from_name === item && result.to_name === item && result.type === 'reactcode',
  );
}

function resultIsReadOnly(item, result) {
  // A self-referencing custom tag is represented by Label Studio as a
  // classification area whose parent points back to this result's control.
  // result.isReadOnly() follows area -> parent.result -> area indefinitely, so
  // read the two authoritative locks without entering that upstream cycle.
  return Boolean(result.readonly || result.area.locked || item.annotation?.isReadOnly());
}

function serializeRegions(item) {
  return matchingResults(item).map((result) => ({
    id: result.area.cleanId,
    value: result.mainValue,
    selected: Boolean(result.area.selected || result.area.inSelection),
    hidden: Boolean(result.area.hidden),
    locked: resultIsReadOnly(item, result),
    origin: result.area.origin ?? undefined,
  }));
}

function viewState(item) {
  const root = getRoot(item);
  const projectId = Number(root?.project?.id);
  const currentScreen = root?.hasInterface?.('review')
    ? 'review_stream'
    : root?.hasInterface?.('annotations:view-all')
      ? 'side_by_side'
      : root?.hasInterface?.('label-stream')
        ? 'label_stream'
        : 'quick_view';
  return {
    projectId: Number.isSafeInteger(projectId) && projectId > 0 ? projectId : null,
    currentScreen,
    darkMode:
      document.documentElement.dataset.colorScheme === 'dark' ||
      document.documentElement.classList.contains('dark'),
    locked: Boolean(item.annotation?.isReadOnly()),
    editable: !item.annotation?.isReadOnly(),
  };
}

const dimensionCache = new Map();

function outputDimensions(outputs) {
  if (!outputs) return [];
  if (dimensionCache.has(outputs)) return dimensionCache.get(outputs);
  let dimensions = [];
  try {
    const schema = JSON.parse(outputs);
    if (
      schema?.type === 'object' &&
      schema?.properties?.reviewStatus &&
      schema?.properties?.boxes &&
      schema?.properties?.catalogId
    ) {
      dimensions = ['$.reviewStatus', '$.boxes.length', '$.boxes[*].species.code'];
    }
  } catch {
    dimensions = [];
  }
  dimensionCache.set(outputs, dimensions);
  return dimensions;
}

function parsedStyle(value) {
  if (!value) return { width: '100%', minHeight: '500px', border: 0 };
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed ? { width: '100%', border: 0, ...parsed } : {};
  } catch {
    return { width: '100%', minHeight: '500px', border: 0 };
  }
}

export const ReactCodeSrcView = observer(({ item }) => {
  const frameRef = useRef(null);
  const readyRef = useRef(false);
  const contextRef = useRef(null);
  const dataRef = useRef(null);
  const viewStateRef = useRef(null);
  const style = useMemo(() => parsedStyle(item.style), [item.style]);
  const hasTaskContext = Boolean(getRoot(item)?.task?.id && item.resolvedData !== null);
  const [stableSource, setStableSource] = useState('');

  useEffect(() => {
    if (!hasTaskContext) {
      setStableSource('');
      return undefined;
    }
    const timer = window.setTimeout(() => setStableSource(item.src), 300);
    return () => window.clearTimeout(timer);
  }, [hasTaskContext, item.src]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;

    const post = (message) =>
      frame.contentWindow?.postMessage(
        { ...message, tag: item.name, context: currentContext(item) },
        window.location.origin,
      );
    const sendRegions = () => post({ type: 'regions', regions: serializeRegions(item) });
    const rejectMutation = () => item.annotation?.isReadOnly();
    const handleMessage = (event) => {
      if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
      const message = event.data;
      if (!message || typeof message !== 'object' || messageSize(message) > 2_000_000) return;
      if (message.tag !== undefined && message.tag !== item.name) return;
      if (message.type === 'ready') {
        readyRef.current = true;
        contextRef.current = currentContext(item);
        dataRef.current = dataSignature(item.resolvedData);
        viewStateRef.current = dataSignature(viewState(item));
        post({
          type: 'init',
          data: item.resolvedData,
          code: '',
          regions: serializeRegions(item),
          viewState: viewState(item),
        });
        return;
      }
      if (!readyRef.current || rejectMutation()) return;
      if (message.context !== currentContext(item)) return;
      if (message.type === 'addRegion') {
        if (matchingResults(item).length !== 0 || !validDocument(message.value)) return;
        item.annotation.createResult(
          { reactcode: message.value },
          { reactcode: message.value },
          item,
          item,
        );
        queueMicrotask(sendRegions);
      } else if (message.type === 'updateRegion') {
        const result = matchingResults(item).find((entry) => entry.area.cleanId === message.id);
        if (!result || resultIsReadOnly(item, result) || !validDocument(message.value)) return;
        result.setValue(message.value);
        queueMicrotask(sendRegions);
      } else if (message.type === 'deleteRegion') {
        const result = matchingResults(item).find((entry) => entry.area.cleanId === message.id);
        if (!result || resultIsReadOnly(item, result)) return;
        item.annotation.unselectAll(true);
        item.annotation.deleteArea(result.area);
        queueMicrotask(sendRegions);
      } else if (message.type === 'selectRegions') {
        // Deliberate singleton no-op: FrogLabel owns its per-box selection.
        sendRegions();
      }
    };

    window.addEventListener('message', handleMessage);
    const dispose = reaction(
      () => ({
        context: currentContext(item),
        data: item.resolvedData,
        regions: serializeRegions(item),
        state: viewState(item),
      }),
      (snapshot) => {
        if (!readyRef.current) return;
        const contextChanged =
          contextRef.current !== null && contextRef.current !== snapshot.context;
        const nextData = dataSignature(snapshot.data);
        const nextViewState = dataSignature(snapshot.state);
        const dataChanged = dataRef.current !== null && dataRef.current !== nextData;
        const viewStateChanged =
          viewStateRef.current !== null && viewStateRef.current !== nextViewState;
        contextRef.current = snapshot.context;
        dataRef.current = nextData;
        viewStateRef.current = nextViewState;
        if (contextChanged || dataChanged) {
          post({
            type: 'update',
            data: snapshot.data,
            regions: snapshot.regions,
            viewState: snapshot.state,
          });
        } else if (viewStateChanged) {
          post({ type: 'viewState', viewState: snapshot.state });
        } else {
          post({ type: 'regions', regions: snapshot.regions });
        }
      },
      { fireImmediately: true },
    );
    return () => {
      readyRef.current = false;
      contextRef.current = null;
      dataRef.current = null;
      viewStateRef.current = null;
      dispose();
      window.removeEventListener('message', handleMessage);
    };
  }, [hasTaskContext, item, stableSource]);

  if (!hasTaskContext || !stableSource) return null;

  return (
    <iframe
      ref={frameRef}
      src={stableSource}
      title="FrogLabel annotation workspace"
      allow={item.allow || undefined}
      style={style}
      data-testid="froglabel-reactcode-frame"
    />
  );
});

function dataSignature(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function currentContext(item) {
  return `${getRoot(item)?.task?.id ?? ''}:${item.annotation?.id ?? ''}`;
}

function messageSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validDocument(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.kind !== 'froglabel.annotation-set' ||
    value.schemaVersion !== 1 ||
    typeof value.catalogId !== 'string' ||
    value.catalogId.length < 1 ||
    value.catalogId.length > 256 ||
    !['calls_present', 'no_calls'].includes(value.reviewStatus) ||
    !Array.isArray(value.boxes) ||
    value.boxes.length > 5000 ||
    (value.reviewStatus === 'calls_present' && value.boxes.length === 0) ||
    (value.reviewStatus === 'no_calls' && value.boxes.length !== 0)
  )
    return false;
  const ids = new Set();
  for (const box of value.boxes) {
    if (
      !box ||
      typeof box !== 'object' ||
      typeof box.id !== 'string' ||
      ids.has(box.id) ||
      !box.species ||
      typeof box.species.speciesId !== 'string' ||
      !/^[A-Z]{3}$/.test(box.species.code) ||
      typeof box.species.speciesName !== 'string' ||
      typeof box.species.addedAfterInitialization !== 'boolean' ||
      !finiteOrdered(box.startTimeSeconds, box.endTimeSeconds, 0) ||
      !finiteOrdered(box.lowFrequencyHz, box.highFrequencyHz, 0) ||
      !box.provenance ||
      !['human', 'model'].includes(box.provenance.source)
    )
      return false;
    ids.add(box.id);
  }
  return true;
}

function documentSummary(value) {
  if (!validDocument(value)) return 'FrogLabel annotation';
  if (value.reviewStatus === 'no_calls') return 'FrogLabel · No calls present';
  const codes = [...new Set(value.boxes.map((box) => box.species.code))];
  const species =
    codes.length > 3 ? `${codes.slice(0, 3).join(', ')} +${codes.length - 3}` : codes.join(', ');
  return `${value.boxes.length} box${value.boxes.length === 1 ? '' : 'es'} · ${species}`;
}

function finiteOrdered(low, high, minimum) {
  return Number.isFinite(low) && Number.isFinite(high) && low >= minimum && high > low;
}

if (!APP_SETTINGS?.billing?.enterprise && !Registry.models.reactcode) {
  Registry.addCustomTag('ReactCode', {
    tag: 'ReactCode',
    isObject: true,
    model: ReactCodeModel,
    view: ReactCodeSrcView,
    resultName: 'reactcode',
    result: types.frozen(),
    region: ReactCodeRegionModel,
    detector: (snapshot) => Boolean(snapshot?.reactcode || snapshot?.value?.reactcode),
  });
}

if (!APP_SETTINGS?.billing?.enterprise && !Registry.models.reactcode) {
  throw new Error(
    'FrogLabel CE adapter could not register ReactCode. Verify custom-tags support and rebuild Label Studio before serving annotators.',
  );
}
