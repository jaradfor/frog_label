import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

type CanonicalDocument = Record<string, unknown> & {
  boxes?: unknown[];
  reviewStatus?: string;
};

type HarnessRegion = {
  id: string;
  value: CanonicalDocument;
  selected: boolean;
  hidden: boolean;
  locked: boolean;
  update(value: CanonicalDocument): void;
  delete(): void;
};

declare global {
  interface Window {
    FrogLabelEnterprise: (props: Record<string, unknown>) => React.ReactNode;
    __enterpriseHarness: {
      annotations: () => Array<{ id: string; value: CanonicalDocument }>;
      lastSubmit: () => CanonicalDocument | null;
      reload(): void;
      reset(): void;
      setDuplicate(): void;
      setLocked(value: boolean): void;
      submit(): void;
      switchTask(): void;
    };
  }
}

export function InlineHost() {
  const regions = useRef<HarnessRegion[]>([]);
  const nextId = useRef(1);
  const submitted = useRef<CanonicalDocument | null>(null);
  const [revision, setRevision] = useState(0);
  const [task, setTask] = useState(1);
  const [locked, setLocked] = useState(false);

  const makeRegion = useCallback(
    (id: string, initial: CanonicalDocument): HarnessRegion => {
      const region: HarnessRegion = {
        id,
        value: structuredClone(initial),
        selected: false,
        hidden: false,
        locked,
        update(value) {
          region.value = structuredClone(value);
          setRevision((value) => value + 1);
        },
        delete() {
          const index = regions.current.indexOf(region);
          if (index >= 0) regions.current.splice(index, 1);
          setRevision((value) => value + 1);
        },
      };
      return region;
    },
    [locked],
  );

  const addRegion = useCallback(
    (value: CanonicalDocument) => {
      const region = makeRegion(`inline:${nextId.current++}`, value);
      regions.current.push(region);
      setRevision((value) => value + 1);
      return region;
    },
    [makeRegion],
  );

  const host = {
    React,
    addRegion,
    regions: regions.current,
    data: {
      froglabel: `${window.location.origin}/audio.wav?task=${task}`,
      froglabelConfig: {
        schemaVersion: 1,
        audio: { filename: 'enterprise-inline-synthetic.wav', mimeType: 'audio/wav' },
      },
    },
    viewState: {
      currentScreen: 'quick_view',
      darkMode: true,
      editable: !locked,
      locked,
    },
  };

  useLayoutEffect(() => {
    window.__enterpriseHarness = {
      annotations: () =>
        regions.current.map((region) => ({
          id: region.id,
          value: structuredClone(region.value),
        })),
      lastSubmit: () => structuredClone(submitted.current),
      reset() {
        regions.current.splice(0);
        submitted.current = null;
        setRevision((value) => value + 1);
      },
      reload() {
        const value = submitted.current;
        if (!value) return;
        const stableId = regions.current[0]?.id ?? `inline:${nextId.current++}`;
        regions.current.splice(0, regions.current.length, makeRegion(stableId, value));
        setRevision((value) => value + 1);
      },
      setDuplicate() {
        const first = regions.current[0];
        if (first) regions.current.push(makeRegion(`inline:${nextId.current++}`, first.value));
        setRevision((value) => value + 1);
      },
      setLocked,
      submit() {
        submitted.current = regions.current[0] ? structuredClone(regions.current[0].value) : null;
        setRevision((value) => value + 1);
      },
      switchTask() {
        regions.current.splice(0);
        submitted.current = null;
        setTask((value) => value + 1);
        setRevision((value) => value + 1);
      },
    };
  }, [makeRegion, revision]);

  return (
    <>
      <nav
        aria-label="Enterprise inline host controls"
        style={{
          alignItems: 'center',
          background: '#111827',
          color: 'white',
          display: 'flex',
          gap: 8,
          padding: 8,
        }}
      >
        <strong>Exact XML host · task {task}</strong>
        <button
          type="button"
          data-testid="host-submit"
          onClick={() => window.__enterpriseHarness.submit()}
        >
          Simulate outer Submit
        </button>
        <button
          type="button"
          data-testid="host-switch"
          onClick={() => window.__enterpriseHarness.switchTask()}
        >
          Switch task
        </button>
        <button
          type="button"
          data-testid="host-reload"
          onClick={() => window.__enterpriseHarness.reload()}
        >
          Reload annotation
        </button>
        <button type="button" data-testid="host-lock" onClick={() => setLocked((value) => !value)}>
          {locked ? 'Unlock' : 'Lock'}
        </button>
        <output data-testid="host-region-count">{regions.current.length} region(s)</output>
      </nav>
      <section data-testid="exact-inline-application">
        {React.createElement(window.FrogLabelEnterprise, host)}
      </section>
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Enterprise inline harness root is missing');
createRoot(root).render(<InlineHost />);
