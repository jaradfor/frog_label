import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

type CanonicalDocument = Record<string, unknown> & {
  boxes?: unknown[];
  reviewStatus?: string;
};

type HarnessRegion = Record<string, unknown> & {
  id: string;
  _froglabelDocument?: CanonicalDocument;
};

type InterfaceHostProps = {
  task: { id: number; data: Record<string, unknown> };
  regions: HarnessRegion[];
  relations: Record<string, unknown>[];
  params: Record<string, unknown>;
  readOnly: boolean;
  addRegion(region: HarnessRegion): unknown;
  updateRegion(id: string, patch: Partial<HarnessRegion>): unknown;
  deleteRegion(id: string): unknown;
};

type InterfaceSpec = {
  default: React.ComponentType<InterfaceHostProps>;
  specVersion: number;
  getResults(regions: readonly unknown[], relations: readonly unknown[]): Record<string, unknown>[];
  parseResults(results: readonly unknown[]): {
    regions: HarnessRegion[];
    relations: Record<string, unknown>[];
  };
};

type SubmittedAnnotation = {
  document: CanonicalDocument | null;
  results: Record<string, unknown>[];
};

declare global {
  interface Window {
    React: typeof React;
    __froglabelBootstrap: Record<string, unknown>;
    __froglabelInterfaceSpec: InterfaceSpec;
    __enterpriseHarness: {
      annotations: () => Array<{ id: string; value: CanonicalDocument }>;
      lastResults: () => Record<string, unknown>[];
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

function documentRegions(
  regions: HarnessRegion[],
): Array<{ id: string; value: CanonicalDocument }> {
  return regions.flatMap((region) =>
    region._froglabelDocument
      ? [{ id: region.id, value: structuredClone(region._froglabelDocument) }]
      : [],
  );
}

function firstDocument(regions: HarnessRegion[]): CanonicalDocument | null {
  return regions.find((region) => region._froglabelDocument)?._froglabelDocument ?? null;
}

export function InterfaceHost({ spec }: { spec: InterfaceSpec }) {
  const submitted = useRef<SubmittedAnnotation | null>(null);
  const [regions, setRegions] = useState<HarnessRegion[]>([]);
  const [taskId, setTaskId] = useState(1);
  const [locked, setLocked] = useState(false);
  const Component = spec.default;

  const addRegion = useCallback((region: HarnessRegion) => {
    const next = structuredClone(region);
    setRegions((current) => [...current, next]);
    return next;
  }, []);

  const updateRegion = useCallback((id: string, patch: Partial<HarnessRegion>) => {
    setRegions((current) =>
      current.map((region) =>
        region.id === id ? { ...region, ...structuredClone(patch) } : region,
      ),
    );
  }, []);

  const deleteRegion = useCallback((id: string) => {
    setRegions((current) => current.filter((region) => region.id !== id));
  }, []);

  const task = useMemo(
    () => ({
      id: taskId,
      data: {
        audio: `${window.location.origin}/audio.wav?task=${taskId}`,
        filename: 'enterprise-interface-synthetic.wav',
        mime_type: 'audio/wav',
        sample_rate_hz: 8_000,
      },
    }),
    [taskId],
  );

  const params = useMemo(
    () => ({
      audioField: 'audio',
      filenameField: 'filename',
      mimeTypeField: 'mime_type',
      sampleRateField: 'sample_rate_hz',
    }),
    [],
  );

  useLayoutEffect(() => {
    window.__enterpriseHarness = {
      annotations: () => documentRegions(regions),
      lastResults: () => structuredClone(submitted.current?.results ?? []),
      lastSubmit: () => structuredClone(submitted.current?.document ?? null),
      reset() {
        submitted.current = null;
        setRegions([]);
      },
      reload() {
        if (!submitted.current) return;
        setRegions(structuredClone(spec.parseResults(submitted.current.results).regions));
      },
      setDuplicate() {
        setRegions((current) => {
          const first = current.find((region) => region._froglabelDocument);
          if (!first) return current;
          return [
            ...current,
            {
              ...structuredClone(first),
              id: `interface:duplicate:${crypto.randomUUID()}`,
            },
          ];
        });
      },
      setLocked,
      submit() {
        const results = spec.getResults(regions, []);
        const parsed = spec.parseResults(results);
        submitted.current = {
          document: structuredClone(firstDocument(parsed.regions)),
          results: structuredClone(results),
        };
      },
      switchTask() {
        submitted.current = null;
        setRegions([]);
        setTaskId((value) => value + 1);
      },
    };
  }, [regions, spec]);

  return (
    <>
      <nav
        aria-label="Enterprise Interface host controls"
        style={{
          alignItems: 'center',
          background: '#111827',
          color: 'white',
          display: 'flex',
          gap: 8,
          padding: 8,
        }}
      >
        <strong>Exact Interface host · task {taskId}</strong>
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
        <output data-testid="host-region-count">{regions.length} region(s)</output>
      </nav>
      <section data-testid="exact-interface-application">
        <Component
          task={task}
          regions={regions}
          relations={[]}
          params={params}
          readOnly={locked}
          addRegion={addRegion}
          updateRegion={updateRegion}
          deleteRegion={deleteRegion}
        />
      </section>
    </>
  );
}

async function bootstrap() {
  window.React = React;
  const response = await fetch('/froglabel.enterprise.jsx');
  if (!response.ok) throw new Error(`Interface source request failed (${response.status})`);
  const source = await response.text();
  // The generated file is the exact single-expression format consumed by the
  // HumanSignal Interface editor. Browser eval returns its final spec object.
  const spec = window.eval(source) as InterfaceSpec;
  if (spec?.specVersion !== 1 || typeof spec.default !== 'function') {
    throw new Error('Generated Enterprise Interface did not evaluate to a v1 Interface spec');
  }
  window.__froglabelInterfaceSpec = spec;
  window.__froglabelBootstrap.interfaceFetched = true;
  window.__froglabelBootstrap.interfaceType = typeof spec.default;
  const root = document.getElementById('root');
  if (!root) throw new Error('Enterprise Interface harness root is missing');
  createRoot(root).render(<InterfaceHost spec={spec} />);
}

void bootstrap().catch((error: unknown) => {
  window.__froglabelBootstrap.bootstrapError =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  queueMicrotask(() => {
    throw error;
  });
});
