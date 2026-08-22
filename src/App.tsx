import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { FrogLabelWorkspace } from './components/workspace/FrogLabelWorkspace';
import { MemoryAnnotationDocumentPort } from './adapters/memory/MemoryAnnotationDocumentPort';
import { MemoryAudioSourcePort } from './adapters/memory/MemoryAudioSourcePort';
import { MemorySpeciesCatalogPort } from './adapters/memory/MemorySpeciesCatalogPort';
import { ReactCodeSrcPort } from './adapters/reactcode/ReactCodeSrcPort';
import { HostAudioSourcePort } from './adapters/reactcode/HostAudioSourcePort';
import { LabelStudioSpeciesCatalogPort } from './adapters/labelStudioCatalog/LabelStudioSpeciesCatalogPort';
import { demoCatalog, emptyLocalCatalog } from './app/catalogs';
import type {
  FrogLabelDocumentV1,
  FrogLabelLocalFileV1,
  LocalAudioDescriptor,
  SpeciesCatalogV1,
} from './domain/types';
import {
  assertMatchingAudio,
  buildLocalFile,
  catalogFromLocalFile,
  downloadFlatCsv,
  downloadLocalFile,
  fingerprintFile,
  localDescriptorFromAudio,
  mergeCatalogSnapshots,
  parseLocalFile,
} from './adapters/local/localFiles';
import type { LoadedAudio } from './audio/AudioResource';
import greenTreeDemoAudioUrl from './assets/green_tree.mp3?url';
import './App.css';

interface LocalSession {
  key: string;
  file: File | null;
  objectUrl: string | null;
  fingerprint: LocalAudioDescriptor['fingerprint'] | null;
  descriptor: LocalAudioDescriptor | null;
  annotation: MemoryAnnotationDocumentPort;
  catalog: MemorySpeciesCatalogPort;
  audio: MemoryAudioSourcePort;
}

interface LocalWorkspaceState {
  session: LocalSession;
  catalog: SpeciesCatalogV1;
  document: FrogLabelDocumentV1 | null;
  baselineSignature: string;
  preparedAt: string | null;
}

function App() {
  const route = routeMode(window.location.pathname, window.parent !== window);
  return (
    <AppErrorBoundary>
      {route === 'local' ? (
        <LocalApp demoHref={import.meta.env.BASE_URL} />
      ) : route === 'embedded' ? (
        <EmbeddedApp />
      ) : (
        <DemoApp />
      )}
    </AppErrorBoundary>
  );
}

export function DemoApp({
  ownAudioHref = `${import.meta.env.BASE_URL}froglabel-local/`,
}: {
  ownAudioHref?: string;
}) {
  const dependencies = useMemo(() => {
    const audioUrl = greenTreeDemoAudioUrl;
    return {
      annotation: new MemoryAnnotationDocumentPort(null, {
        data: audioUrl,
        trustValidatedMutations: true,
      }),
      catalog: new MemorySpeciesCatalogPort(demoCatalog),
      audio: new MemoryAudioSourcePort({
        url: audioUrl,
        filename: 'green_tree.mp3',
        mimeType: 'audio/mpeg',
        trustedSampleRateHz: 44_100,
      }),
    };
  }, []);
  useEffect(
    () => () => {
      dependencies.annotation.destroy();
      dependencies.catalog.destroy();
      dependencies.audio.destroy();
    },
    [dependencies],
  );
  return (
    <FrogLabelWorkspace
      annotationPort={dependencies.annotation}
      catalogPort={dependencies.catalog}
      audioSourcePort={dependencies.audio}
      mode="demo"
      speciesCreateScope="session"
      headerExtras={
        <>
          <span className="mode-badge">GRE demo recording</span>
          <a className="header-link" href={ownAudioHref}>
            Try your own audio
          </a>
        </>
      }
    />
  );
}

function EmbeddedApp() {
  const annotation = useMemo(() => {
    const allowlist = (import.meta.env.VITE_FROGLABEL_PARENT_ORIGINS ?? '')
      .split(',')
      .map((value: string) => value.trim())
      .filter(Boolean);
    return new ReactCodeSrcPort({ allowedParentOrigins: allowlist });
  }, []);
  const [host, setHost] = useState(() => annotation.getSnapshot());
  useEffect(() => annotation.subscribe(setHost), [annotation]);
  useEffect(() => () => annotation.destroy(), [annotation]);
  const projectId = host.viewState?.projectId;
  const hostStatus = annotation.getStatus();
  if (hostStatus.phase === 'error') {
    return (
      <SetupFailure
        message={hostStatus.error?.message ?? 'Label Studio supplied invalid task context.'}
        repair={hostStatus.error?.repair ?? 'Correct the task data and reopen this task.'}
      />
    );
  }
  if (host.epoch === 0 || host.data === null) {
    return (
      <SetupFailure message="Waiting for Label Studio context…" repair="Keep this task open." />
    );
  }
  if (!Number.isSafeInteger(projectId) || Number(projectId) <= 0) {
    return (
      <SetupFailure
        message="Label Studio did not supply an authoritative project context."
        repair="Run froglabel project validate --project PROJECT_ID and rebuild the pinned CE adapter."
      />
    );
  }
  return <EmbeddedWorkspace projectId={Number(projectId)} annotation={annotation} />;
}

function EmbeddedWorkspace({
  projectId,
  annotation,
}: {
  projectId: number;
  annotation: ReactCodeSrcPort;
}) {
  const dependencies = useMemo(() => {
    return {
      catalog: new LabelStudioSpeciesCatalogPort(projectId),
      audio: new HostAudioSourcePort(annotation),
    };
  }, [annotation, projectId]);
  useEffect(
    () => () => {
      dependencies.audio.destroy();
      dependencies.catalog.destroy();
    },
    [dependencies],
  );
  return (
    <FrogLabelWorkspace
      annotationPort={annotation}
      catalogPort={dependencies.catalog}
      audioSourcePort={dependencies.audio}
      mode="embedded"
      speciesCreateScope="project"
      headerExtras={<span className="mode-badge">Project {projectId}</span>}
    />
  );
}

export function LocalApp({ demoHref }: { demoHref?: string } = {}) {
  const [local, setLocal] = useState<LocalWorkspaceState>(() => {
    const catalog = emptyLocalCatalog();
    return {
      session: makeLocalSession(null, null, catalog, null),
      catalog,
      document: null,
      baselineSignature: localWorkSignature(catalog, null),
      preparedAt: null,
    };
  });
  const session = local.session;
  const sessionRef = useRef(session);
  const [pendingResume, setPendingResume] = useState<FrogLabelLocalFileV1 | null>(null);
  const [notice, setNotice] = useState('Open a WAV or MP3. Files stay in this browser tab.');
  const [error, setError] = useState('');
  const audioInputRef = useRef<HTMLInputElement>(null);
  const resumeInputRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef<{ controller: AbortController } | null>(null);
  const currentSignature = useMemo(
    () => localWorkSignature(local.catalog, local.document),
    [local.catalog, local.document],
  );
  const dirty = currentSignature !== local.baselineSignature;

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(
    () =>
      session.annotation.subscribe((snapshot) => {
        setLocal((current) =>
          current.session === session ? { ...current, document: snapshot.document } : current,
        );
      }),
    [session],
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(
    () => () => {
      operationRef.current?.controller.abort();
      disposeLocalSession(sessionRef.current);
    },
    [],
  );

  const replaceSession = useCallback(
    (
      next: LocalSession,
      catalog: SpeciesCatalogV1,
      document: FrogLabelDocumentV1 | null,
      options: { baselineSignature?: string; preparedAt?: string | null } = {},
    ) => {
      const previous = sessionRef.current;
      sessionRef.current = next;
      setLocal({
        session: next,
        catalog: structuredClone(catalog),
        document: structuredClone(document),
        baselineSignature: options.baselineSignature ?? localWorkSignature(catalog, document),
        preparedAt: options.preparedAt ?? null,
      });
      disposeLocalSession(previous, previous.objectUrl !== next.objectUrl);
    },
    [],
  );

  const startOperation = () => {
    operationRef.current?.controller.abort();
    const operation = { controller: new AbortController() };
    operationRef.current = operation;
    return operation;
  };

  const openAudio = async (file: File) => {
    setError('');
    if (!isSupportedAudio(file)) {
      setError('Choose a WAV or MP3 file.');
      return;
    }
    if (
      dirty &&
      !window.confirm(
        'This audio replacement clears the current annotation. Continue? Session species remain available.',
      )
    )
      return;
    const operation = startOperation();
    try {
      const currentCatalog = await session.catalog.read();
      const fingerprint = pendingResume
        ? await assertMatchingAudio(file, pendingResume.audio, operation.controller.signal)
        : await fingerprintFile(file, operation.controller.signal);
      if (operationRef.current !== operation || operation.controller.signal.aborted) return;
      const resumedCatalog = pendingResume
        ? mergeCatalogSnapshots(catalogFromLocalFile(pendingResume), currentCatalog.species)
        : currentCatalog;
      const document = pendingResume?.document ?? null;
      const objectUrl = URL.createObjectURL(file);
      if (operationRef.current !== operation || operation.controller.signal.aborted) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      replaceSession(
        makeLocalSession(
          file,
          objectUrl,
          resumedCatalog,
          document,
          fingerprint,
          pendingResume?.audio ?? null,
        ),
        resumedCatalog,
        document,
        pendingResume
          ? undefined
          : { baselineSignature: local.baselineSignature, preparedAt: null },
      );
      setNotice(
        pendingResume
          ? `Validated and resumed ${pendingResume.audio.filename}.`
          : `Opened ${file.name}. Audio stays in this browser tab.`,
      );
      setPendingResume(null);
    } catch (caught) {
      if (!isAbortError(caught)) setError(readLocalError(caught));
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
    }
  };

  const resume = async (file: File) => {
    setError('');
    const operation = startOperation();
    try {
      const parsed = await parseLocalFile(file);
      if (operationRef.current !== operation || operation.controller.signal.aborted) return;
      if (dirty && !window.confirm('Loading this JSON replaces the current annotation. Continue?'))
        return;
      const candidateCatalog = catalogFromLocalFile(parsed);
      const currentCatalog = await session.catalog.read();
      const mergedCatalog = mergeCatalogSnapshots(candidateCatalog, currentCatalog.species);
      if (session.file) {
        const fingerprint = await assertMatchingAudio(
          session.file,
          parsed.audio,
          operation.controller.signal,
        );
        if (operationRef.current !== operation || operation.controller.signal.aborted) return;
        replaceSession(
          makeLocalSession(
            session.file,
            session.objectUrl,
            mergedCatalog,
            parsed.document,
            fingerprint,
            parsed.audio,
          ),
          mergedCatalog,
          parsed.document,
        );
        setNotice(`Validated and resumed annotations for ${parsed.audio.filename}.`);
      } else {
        setPendingResume(parsed);
        setNotice(
          `Now choose the matching audio: ${parsed.audio.filename} (${parsed.audio.sizeBytes.toLocaleString()} bytes).`,
        );
        audioInputRef.current?.click();
      }
    } catch (caught) {
      if (!isAbortError(caught)) setError(readLocalError(caught));
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
    }
  };

  const audioLoaded = useCallback((audio: LoadedAudio) => {
    const current = sessionRef.current;
    if (!current.file || !current.fingerprint || audio.source.url !== current.objectUrl) return;
    const descriptor = localDescriptorFromAudio(
      audio,
      current.fingerprint,
      current.file.size,
      current.file.type || undefined,
    );
    const next = { ...current, descriptor };
    sessionRef.current = next;
    setLocal((value) => (value.session === current ? { ...value, session: next } : value));
  }, []);

  const downloadJson = async () => {
    if (!session.descriptor) {
      setError('Wait for audio decoding to finish before preparing JSON.');
      return;
    }
    try {
      const catalog = await session.catalog.read();
      const document = session.annotation.getSnapshot().document;
      const value = buildLocalFile(session.descriptor, catalog, document);
      downloadLocalFile(value);
      const preparedAt = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      setLocal((current) => ({
        ...current,
        catalog,
        document,
        baselineSignature: localWorkSignature(catalog, document),
        preparedAt,
      }));
      setNotice('JSON download prepared. Audio bytes are not included.');
    } catch (caught) {
      setError(readLocalError(caught));
    }
  };

  const downloadCsv = async () => {
    if (!session.descriptor) {
      setError('Wait for audio decoding to finish before preparing CSV.');
      return;
    }
    try {
      const catalog = await session.catalog.read();
      const document = session.annotation.getSnapshot().document;
      downloadFlatCsv(buildLocalFile(session.descriptor, catalog, document));
      setNotice('CSV download prepared. JSON preparation status is unchanged.');
    } catch (caught) {
      setError(readLocalError(caught));
    }
  };

  const startUnrelatedCatalog = async () => {
    if (
      dirty &&
      !window.confirm('Reset the annotation and the entire page-session species catalog?')
    )
      return;
    const catalog = emptyLocalCatalog();
    replaceSession(
      makeLocalSession(
        session.file,
        session.objectUrl,
        catalog,
        null,
        session.fingerprint,
        session.descriptor,
      ),
      catalog,
      null,
    );
    setPendingResume(null);
    setError('');
    setNotice('Started an unrelated empty catalog.');
  };

  const addDemoSpecies = async () => {
    try {
      const catalog = mergeCatalogSnapshots(await session.catalog.read(), demoCatalog.species);
      replaceSession(
        makeLocalSession(
          session.file,
          session.objectUrl,
          catalog,
          local.document,
          session.fingerprint,
          session.descriptor,
        ),
        catalog,
        local.document,
        { baselineSignature: local.baselineSignature, preparedAt: local.preparedAt },
      );
      setNotice('Added the explicit demo species to this page-session catalog.');
    } catch (caught) {
      setError(readLocalError(caught));
    }
  };

  const persistenceLabel = dirty
    ? local.preparedAt
      ? 'Changes since JSON preparation'
      : 'No JSON prepared · changes in memory'
    : local.preparedAt
      ? `JSON download prepared at ${local.preparedAt}`
      : 'No JSON prepared';
  const canResetLocalWork =
    local.catalog.species.length > 0 || local.document !== null || pendingResume !== null;

  const openAudioButton = (label: string) => (
    <button type="button" onClick={() => audioInputRef.current?.click()}>
      {label}
    </button>
  );

  const resumeButton = (label: string) => (
    <button type="button" onClick={() => resumeInputRef.current?.click()}>
      {label}
    </button>
  );

  const controls = (
    <div className="local-controls" aria-label="Local file controls">
      {demoHref && (
        <a className="header-link" href={demoHref}>
          Seeded demo
        </a>
      )}
      <input
        ref={audioInputRef}
        className="visually-hidden-input"
        type="file"
        accept="audio/wav,audio/x-wav,audio/mpeg,.wav,.mp3"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void openAudio(file);
          event.currentTarget.value = '';
        }}
      />
      <input
        ref={resumeInputRef}
        className="visually-hidden-input"
        type="file"
        accept="application/json,.json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void resume(file);
          event.currentTarget.value = '';
        }}
      />
      {openAudioButton('Open audio')}
      {resumeButton('Resume annotations')}
      <button type="button" onClick={() => void downloadJson()} disabled={!session.descriptor}>
        Download JSON
      </button>
      <button type="button" onClick={() => void downloadCsv()} disabled={!session.descriptor}>
        Download CSV
      </button>
      <button type="button" onClick={() => void addDemoSpecies()}>
        Add demo species
      </button>
      <button
        type="button"
        onClick={() => void startUnrelatedCatalog()}
        disabled={!canResetLocalWork}
      >
        Reset local work
      </button>
      <span className="local-notice" role={error ? 'alert' : 'status'}>
        {error || notice}
      </span>
    </div>
  );

  return (
    <FrogLabelWorkspace
      key={session.key}
      annotationPort={session.annotation}
      catalogPort={session.catalog}
      audioSourcePort={session.audio}
      mode="local"
      speciesCreateScope="session"
      headerExtras={controls}
      emptyAudioState={
        <div className="local-empty-state">
          <strong>Open audio to start labeling</strong>
          <p>Choose a WAV or MP3 from this computer, or resume a saved FrogLabel JSON file.</p>
          <div className="local-empty-actions">
            {openAudioButton('Open WAV or MP3')}
            {resumeButton('Resume from JSON')}
            {demoHref && (
              <a className="local-demo-link" href={demoHref}>
                Open the working sample demo
              </a>
            )}
          </div>
          <small>Your audio stays in this browser tab and is never uploaded.</small>
        </div>
      }
      onAudioLoaded={audioLoaded}
      onCatalogChanged={(catalog) =>
        setLocal((current) => (current.session === session ? { ...current, catalog } : current))
      }
      persistenceLabel={persistenceLabel}
    />
  );
}

function makeLocalSession(
  file: File | null,
  objectUrl: string | null,
  catalog: SpeciesCatalogV1,
  document: FrogLabelDocumentV1 | null,
  fingerprint: LocalAudioDescriptor['fingerprint'] | null = null,
  descriptor: LocalAudioDescriptor | null = null,
): LocalSession {
  return {
    key: crypto.randomUUID(),
    file,
    objectUrl,
    fingerprint,
    descriptor,
    annotation: new MemoryAnnotationDocumentPort(document, {
      data: objectUrl,
      trustValidatedMutations: true,
    }),
    catalog: new MemorySpeciesCatalogPort(catalog),
    audio: new MemoryAudioSourcePort(
      file && objectUrl
        ? {
            url: objectUrl,
            filename: file.name,
            ...(file.type ? { mimeType: file.type } : {}),
          }
        : null,
    ),
  };
}

function localWorkSignature(
  catalog: SpeciesCatalogV1,
  document: FrogLabelDocumentV1 | null,
): string {
  // Local state is immutable and schema-validated before it reaches this
  // comparison. Property order therefore remains stable within the session;
  // plain serialization avoids recursively sorting thousands of box objects
  // after every gesture while retaining exact dirty-state semantics.
  return JSON.stringify({ catalog, document });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function disposeLocalSession(session: LocalSession, revokeUrl = true): void {
  session.annotation.destroy();
  session.catalog.destroy();
  session.audio.destroy();
  if (revokeUrl && session.objectUrl) URL.revokeObjectURL(session.objectUrl);
}

function routeMode(pathname: string, framed: boolean): 'embedded' | 'local' | 'demo' {
  const path = pathname.replace(/\/+$/u, '');
  if (path.endsWith('/froglabel-local')) return 'local';
  if (path.endsWith('/embedded') || framed) return 'embedded';
  return 'demo';
}

function isSupportedAudio(file: File): boolean {
  return (
    /\.(wav|mp3)$/iu.test(file.name) ||
    ['audio/wav', 'audio/x-wav', 'audio/mpeg'].includes(file.type)
  );
}

function readLocalError(error: unknown): string {
  if (error && typeof error === 'object' && 'structured' in error) {
    const value = (error as { structured: { message: string; detail?: string } }).structured;
    return [value.message, value.detail].filter(Boolean).join(' ');
  }
  return error instanceof Error ? error.message : 'Local file operation failed.';
}

function SetupFailure({ message, repair }: { message: string; repair: string }) {
  return (
    <main className="setup-failure">
      <div>
        <span className="eyebrow">FrogLabel integration error</span>
        <h1>{message}</h1>
        <p>{repair}</p>
        <code>/react-app/froglabel/index.html</code>
      </div>
    </main>
  );
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // Deliberately local and data-minimal: no telemetry or annotation payloads.
    console.error(
      'FrogLabel render failure',
      error.name,
      info.componentStack?.split('\n').slice(0, 4).join('\n'),
    );
  }
  render() {
    if (this.state.error)
      return (
        <SetupFailure
          message="FrogLabel could not render this workspace."
          repair={this.state.error.message}
        />
      );
    return this.props.children;
  }
}

export default App;
