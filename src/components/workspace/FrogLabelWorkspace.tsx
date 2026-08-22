import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import logo from '../../assets/frog_id_logo.png';
import type { AnnotationDocumentPort } from '../../ports/AnnotationDocumentPort';
import type { AudioSourcePort, AudioSourceSnapshot } from '../../ports/AudioSourcePort';
import type { SpeciesCatalogPort } from '../../ports/SpeciesCatalogPort';
import type {
  FrogLabelBoxV1,
  HostSnapshot,
  HostStatus,
  MutationReason,
  AnalysisChannelMode,
  SpeciesCatalogV1,
  SpeciesEntryV1,
} from '../../domain/types';
import { createStableId, deterministicSerialize } from '../../domain/document';
import {
  domainReducer,
  initialDomainState,
  type DomainCommand,
  type DomainState,
} from '../../domain/reducer';
import { loadAudioResource, type AudioPlayback, type LoadedAudio } from '../../audio/AudioResource';
import type { SpectrogramRenderPhase } from '../../audio/SpectrogramRenderer';
import { MemoryAnnotationDocumentPort } from '../../adapters/memory/MemoryAnnotationDocumentPort';
import { MemoryAudioSourcePort } from '../../adapters/memory/MemoryAudioSourcePort';
import { MemorySpeciesCatalogPort } from '../../adapters/memory/MemorySpeciesCatalogPort';
import { tutorialCatalog } from '../../app/catalogs';
import { commandForKeyboardEvent, type WorkspaceCommandId } from '../../app/keyboard';
import { SpectrogramCanvas } from './SpectrogramCanvas';
import type { FrequencyScale, SpectrogramPalette } from '../../audio/spectrogram';

export interface FrogLabelWorkspaceProps {
  annotationPort: AnnotationDocumentPort;
  catalogPort: SpeciesCatalogPort;
  audioSourcePort: AudioSourcePort;
  mode: 'embedded' | 'local' | 'demo';
  headerExtras?: ReactNode;
  emptyAudioState?: ReactNode;
  onAudioLoaded?: (audio: LoadedAudio) => void;
  persistenceLabel?: string;
  onCatalogChanged?: (catalog: SpeciesCatalogV1) => void;
  speciesCreateScope?: 'project' | 'annotation' | 'session';
  tutorialAudioSource?: AudioSourceSnapshot;
}

interface TutorialSession {
  annotation: MemoryAnnotationDocumentPort;
  catalog: MemorySpeciesCatalogPort;
  audio: MemoryAudioSourcePort;
}

// TODO(tutorial-real-audio): replace only this asset/descriptor with the user's
// licensed, biologically verified PER call; tutorial logic must remain unchanged.
const DEFAULT_TUTORIAL_AUDIO = {
  url: `${import.meta.env.BASE_URL}audio/synthetic-frog-practice.wav`,
  filename: 'synthetic-frog-practice.wav',
  mimeType: 'audio/wav',
  trustedSampleRateHz: 44_100,
  description: 'Temporary synthetic practice audio — not a verified PER reference recording',
} as const;

const tutorialSteps = [
  {
    title: 'Welcome',
    text: 'Two-minute practice using the real FrogLabel workspace. Practice changes are never saved.',
    anchor: 'help',
  },
  {
    title: 'Listen',
    text: `${DEFAULT_TUTORIAL_AUDIO.description}. Wait for the spectrogram to finish building, then play it once.`,
    anchor: 'play',
  },
  {
    title: 'Choose PER',
    text: "Choose PER — Peron's Tree Frog from the species selector.",
    anchor: 'species',
  },
  {
    title: 'Draw tool',
    text: 'Select Draw Box. The same command is available with D.',
    anchor: 'draw',
  },
  {
    title: 'Draw',
    text: 'Drag a time–frequency box around one bright call in the real spectrogram.',
    anchor: 'spectrogram',
  },
  {
    title: 'Select tool',
    text: 'Choose Select so the practice box can be inspected and resized. The same command is available with V.',
    anchor: 'select',
  },
  {
    title: 'Select and resize',
    text: 'Select the same box and drag one corner handle. Keep one box; its identity and scientific coordinates update in place.',
    anchor: 'spectrogram',
  },
  {
    title: 'Inspect',
    text: 'Inspect the selected species, time, and frequency in Box Details and Annotation Dataset.',
    anchor: 'details',
  },
  {
    title: 'Zoom, pan, and fit',
    text: 'Try Zoom, Pan, and Reset / Fit. These view changes never alter scientific coordinates.',
    anchor: 'zoom',
  },
  {
    title: 'Missing species',
    text: 'Open Add missing species if you wish. The real form writes only to this isolated practice catalog and is never required.',
    anchor: 'add-species',
  },
  {
    title: 'No calls present',
    text: 'Use No calls present (Shift+N) only for a reviewed recording with no calls. Do not activate it in this positive-call exercise.',
    anchor: 'no-calls',
  },
  {
    title: 'Finished',
    text: 'Finish to discard practice and restore the authoritative task paused. Nothing from this tutorial is submitted or saved.',
    anchor: null,
  },
] as const;

export function FrogLabelWorkspace(props: FrogLabelWorkspaceProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [tutorialActive, setTutorialActive] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);
  const [tutorialRun, setTutorialRun] = useState(0);
  const [tutorialEvents, setTutorialEvents] = useState<Set<string>>(new Set());
  const [tutorialMessage, setTutorialMessage] = useState('');
  const [entryEpoch, setEntryEpoch] = useState<number | null>(null);
  const liveHelpButtonRef = useRef<HTMLButtonElement>(null);
  const tutorialHelpButtonRef = useRef<HTMLButtonElement>(null);
  const tutorialAudio = props.tutorialAudioSource ?? DEFAULT_TUTORIAL_AUDIO;

  const tutorialSession = useMemo<TutorialSession | null>(() => {
    if (!tutorialActive) return null;
    return {
      annotation: new MemoryAnnotationDocumentPort(null, {
        tag: `froglabel-tutorial:${tutorialRun}`,
        data: tutorialAudio.url,
        trustValidatedMutations: true,
      }),
      catalog: new MemorySpeciesCatalogPort(tutorialCatalog, true),
      audio: new MemoryAudioSourcePort({
        ...tutorialAudio,
        mimeType: tutorialAudio.mimeType ?? 'audio/wav',
      }),
    };
  }, [tutorialActive, tutorialAudio, tutorialRun]);

  useEffect(
    () => () => {
      tutorialSession?.annotation.destroy();
      tutorialSession?.catalog.destroy();
      tutorialSession?.audio.destroy();
    },
    [tutorialSession],
  );

  const exitTutorial = useCallback(
    (message = 'Practice discarded. Your live annotation was not changed.') => {
      setTutorialActive(false);
      setTutorialStep(0);
      setTutorialEvents(new Set());
      setEntryEpoch(null);
      setTutorialMessage(message);
      queueMicrotask(() => liveHelpButtonRef.current?.focus());
    },
    [],
  );

  useEffect(
    () =>
      props.annotationPort.subscribe((snapshot) => {
        if (tutorialActive && entryEpoch !== null && snapshot.epoch !== entryEpoch) {
          exitTutorial('The task changed; the tutorial was closed. Practice was discarded.');
        }
      }),
    [entryEpoch, exitTutorial, props.annotationPort, tutorialActive],
  );

  useEffect(() => {
    if (!tutorialActive || helpOpen) return;
    const handle = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey)
        return;
      if (event.code === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        exitTutorial();
      } else if (event.code === 'Space' && !isTutorialTextEntryTarget(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (tutorialStep === tutorialSteps.length - 1) exitTutorial();
        else setTutorialStep((step) => step + 1);
      }
    };
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, [exitTutorial, helpOpen, tutorialActive, tutorialStep]);

  const startTutorial = () => {
    setEntryEpoch(props.annotationPort.getSnapshot().epoch);
    setTutorialRun((run) => run + 1);
    setTutorialActive(true);
    setTutorialStep(0);
    setTutorialEvents(new Set());
    setHelpOpen(false);
    setTutorialMessage('');
  };

  const semanticEvent = (event: string) => {
    if (!tutorialActive) return;
    setTutorialEvents((events) => new Set(events).add(event));
  };

  return (
    <div className="workspace-host">
      <div
        className={`workspace-layer live-workspace-layer ${tutorialSession ? 'tutorial-live-hidden' : ''}`}
        aria-hidden={tutorialSession ? true : undefined}
        inert={tutorialSession ? true : undefined}
      >
        <WorkspaceCore
          key="live"
          {...props}
          onHelp={() => setHelpOpen(true)}
          helpButtonRef={liveHelpButtonRef}
          onSemanticEvent={() => undefined}
          tutorialMessage={tutorialMessage}
          tutorialStep={undefined}
          suspended={Boolean(tutorialSession)}
        />
      </div>
      {tutorialSession && (
        <div className="workspace-layer tutorial-practice-layer">
          <WorkspaceCore
            key={`tutorial:${tutorialRun}`}
            annotationPort={tutorialSession.annotation}
            catalogPort={tutorialSession.catalog}
            audioSourcePort={tutorialSession.audio}
            mode="demo"
            headerExtras={<span className="mode-badge tutorial">Tutorial · changes discarded</span>}
            onHelp={() => setHelpOpen(true)}
            helpButtonRef={tutorialHelpButtonRef}
            onSemanticEvent={semanticEvent}
            speciesCreateScope="session"
            tutorialMessage=""
            persistenceLabel="Practice only — changes discarded"
            tutorialStep={tutorialStep}
            suspended={false}
          />
        </div>
      )}
      {helpOpen && (
        <HelpDialog
          mode={props.mode}
          onClose={() => {
            setHelpOpen(false);
            queueMicrotask(() =>
              (tutorialSession ? tutorialHelpButtonRef : liveHelpButtonRef).current?.focus(),
            );
          }}
          onStart={startTutorial}
        />
      )}
      {tutorialActive && (
        <TutorialOverlay
          step={tutorialStep}
          tried={
            eventForStep(tutorialStep) ? tutorialEvents.has(eventForStep(tutorialStep)!) : false
          }
          onNext={() => {
            if (tutorialStep === tutorialSteps.length - 1) exitTutorial();
            else setTutorialStep((step) => step + 1);
          }}
          onBack={() => setTutorialStep((step) => Math.max(0, step - 1))}
          onRestart={() => {
            setTutorialRun((run) => run + 1);
            setTutorialStep(0);
            setTutorialEvents(new Set());
            setTutorialMessage('');
          }}
          onExit={() => exitTutorial()}
        />
      )}
    </div>
  );
}

function WorkspaceCore({
  annotationPort,
  catalogPort,
  audioSourcePort,
  mode,
  headerExtras,
  emptyAudioState,
  onHelp,
  helpButtonRef,
  onSemanticEvent,
  onAudioLoaded,
  onCatalogChanged,
  speciesCreateScope,
  tutorialMessage,
  persistenceLabel,
  tutorialStep,
  suspended = false,
}: FrogLabelWorkspaceProps & {
  onHelp(): void;
  helpButtonRef: React.RefObject<HTMLButtonElement | null>;
  onSemanticEvent(event: string, detail?: string): void;
  tutorialMessage: string;
  persistenceLabel?: string;
  tutorialStep?: number;
  suspended?: boolean;
}) {
  const [host, setHost] = useState<HostSnapshot>(() => annotationPort.getSnapshot());
  const [hostStatus, setHostStatus] = useState<HostStatus>(() => annotationPort.getStatus());
  const [audioSource, setAudioSource] = useState<AudioSourceSnapshot | null>(() =>
    audioSourcePort.getSnapshot(),
  );
  const [catalog, setCatalog] = useState<SpeciesCatalogV1 | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [audio, setAudio] = useState<LoadedAudio | null>(null);
  const [audioPhase, setAudioPhase] = useState<'waiting' | 'loading' | 'ready' | 'error'>(
    'waiting',
  );
  const [audioError, setAudioError] = useState('');
  const [spectrogramPhase, setSpectrogramPhase] = useState<SpectrogramRenderPhase>('analyzing');
  const [domain, setDomain] = useState<DomainState>(() =>
    initialDomainState('waiting', { durationSeconds: 1, maximumFrequencyHz: 1 }),
  );
  const domainRef = useRef(domain);
  const contextKeyRef = useRef('');
  const pendingExpectedRef = useRef<string | null>(null);
  const [pendingDomain, setPendingDomain] = useState<DomainState | null>(null);
  const [mutationError, setMutationError] = useState('');
  const [currentSpeciesId, setCurrentSpeciesId] = useState('');
  const [tool, setTool] = useState<'select' | 'draw' | 'pan'>('select');
  const [gestureCancelVersion, setGestureCancelVersion] = useState(0);
  const [panels, setPanels] = useState({
    species: true,
    details: true,
    display: false,
    dataset: true,
  });
  const [dark, setDark] = useState(true);
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [view, setView] = useState({
    durationSeconds: 1,
    maximumFrequencyHz: 1,
    timeStartSeconds: 0,
    timeEndSeconds: 1,
    lowFrequencyHz: 0,
    highFrequencyHz: 1,
  });
  const [settings, setSettings] = useState<{
    fftSamples: number;
    overlapPercent: number;
    brightness: number;
    contrast: number;
    palette: SpectrogramPalette;
    channelMode: AnalysisChannelMode;
    frequencyScale: FrequencyScale;
  }>({
    fftSamples: 512,
    overlapPercent: 75,
    brightness: 1.25,
    contrast: 1,
    palette: 'viridis',
    channelMode: 'average',
    frequencyScale: 'linear',
  });
  const [announcement, setAnnouncement] = useState(tutorialMessage);

  useEffect(() => {
    domainRef.current = domain;
  }, [domain]);

  useEffect(
    () =>
      annotationPort.subscribe((snapshot) => {
        setHost(snapshot);
        setHostStatus(annotationPort.getStatus());
      }),
    [annotationPort],
  );

  useEffect(
    () =>
      audioSourcePort.subscribe((next) => {
        setAudioSource((current) => (sameAudioSource(current, next) ? current : next));
      }),
    [audioSourcePort],
  );

  const refreshCatalog = useCallback(
    async (signal?: AbortSignal) => {
      setCatalogError('');
      try {
        setCatalog(await catalogPort.read(signal));
      } catch (error) {
        if (!signal?.aborted) setCatalogError(readError(error));
      }
    },
    [catalogPort],
  );

  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null);
    void refreshCatalog(controller.signal);
    return () => controller.abort();
  }, [host.epoch, refreshCatalog]);

  useEffect(() => {
    if (!audioSource) {
      setAudioPhase('waiting');
      setSpectrogramPhase('analyzing');
      setAudio(null);
      return;
    }
    const controller = new AbortController();
    setAudio(null);
    setAudioPhase('loading');
    setSpectrogramPhase('analyzing');
    setAudioError('');
    let loaded: LoadedAudio | null = null;
    loadAudioResource(audioSource, controller.signal)
      .then((resource) => {
        if (controller.signal.aborted) {
          resource.dispose();
          return;
        }
        loaded = resource;
        setAudio(resource);
        setAudioPhase('ready');
        onAudioLoaded?.(resource);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setAudioPhase('error');
          setAudioError(readError(error));
        }
      });
    return () => {
      controller.abort();
      loaded?.dispose();
    };
  }, [audioSource, onAudioLoaded]);

  useEffect(() => {
    if (!audio) return;
    const element = audio.element;
    const update = () => setPlayhead(element.currentTime);
    const play = () => {
      setIsPlaying(true);
      onSemanticEvent('audio.played');
    };
    const pause = () => setIsPlaying(false);
    const restoreRate = () => {
      if (!assignPlaybackRate(element, playbackRate)) {
        assignPlaybackRate(element, 1);
        setPlaybackRate(1);
      }
    };
    element.addEventListener('timeupdate', update);
    element.addEventListener('play', play);
    element.addEventListener('pause', pause);
    element.addEventListener('loadedmetadata', restoreRate);
    restoreRate();
    return () => {
      element.removeEventListener('timeupdate', update);
      element.removeEventListener('play', play);
      element.removeEventListener('pause', pause);
      element.removeEventListener('loadedmetadata', restoreRate);
    };
  }, [audio, onSemanticEvent, playbackRate]);

  useEffect(() => {
    if (!audio || !catalog) return;
    const bounds = {
      durationSeconds: audio.durationSeconds,
      maximumFrequencyHz: audio.maximumFrequencyHz,
      analysisSampleRateHz: audio.analysis.sampleRateHz,
    };
    const contextKey = `${host.epoch}:${catalog.catalogId}:${audio.source.url}`;
    if (contextKeyRef.current !== contextKey) {
      if (host.document && host.document.catalogId !== catalog.catalogId) {
        setMutationError(
          `Document catalog ${host.document.catalogId} does not match project catalog ${catalog.catalogId}.`,
        );
        return;
      }
      contextKeyRef.current = contextKey;
      const next = domainReducer(domainRef.current, {
        type: 'context/replace',
        epoch: host.epoch,
        catalogId: catalog.catalogId,
        bounds,
        document: host.document,
      });
      setDomain(next);
      domainRef.current = next;
      setPendingDomain(null);
      pendingExpectedRef.current = null;
      const defaultEntry = catalog.species.find(
        (entry) => entry.speciesId === catalog.defaultSpeciesId,
      );
      setCurrentSpeciesId(defaultEntry?.speciesId ?? '');
      setTool('select');
      setView({
        ...bounds,
        timeStartSeconds: 0,
        timeEndSeconds: audio.durationSeconds,
        lowFrequencyHz: 0,
        highFrequencyHz: audio.maximumFrequencyHz,
      });
      setAnnouncement(
        `Loaded ${audio.source.filename}. ${host.locked ? 'Read-only.' : 'Ready to annotate.'}`,
      );
      return;
    }
    if (
      pendingExpectedRef.current === null &&
      deterministicSerialize(host.document) !== deterministicSerialize(domainRef.current.document)
    ) {
      const next = domainReducer(domainRef.current, {
        type: 'context/replace',
        epoch: host.epoch,
        catalogId: catalog.catalogId,
        bounds,
        document: host.document,
      });
      setDomain(next);
      domainRef.current = next;
      setAnnouncement('Annotation reconciled with the host.');
    }
  }, [audio, catalog, host.document, host.epoch, host.locked]);

  const visualDomain = pendingDomain ?? domain;
  const boxes = useMemo(() => visualDomain.document?.boxes ?? [], [visualDomain.document?.boxes]);
  const selectedBox = boxes.find((box) => box.id === visualDomain.selectedBoxId) ?? null;
  const currentSpecies =
    catalog?.species.find((entry) => entry.speciesId === currentSpeciesId) ?? null;
  const spectrogramReady =
    audioPhase === 'ready' && spectrogramPhase === 'firstFrameReady' && Boolean(audio);
  const hostEditable =
    hostStatus.phase !== 'read-only' &&
    !host.locked &&
    hostStatus.phase !== 'waiting' &&
    hostStatus.phase !== 'error';
  const editable = hostEditable && spectrogramReady && !suspended;

  useEffect(() => {
    if (suspended) audio?.element.pause();
  }, [audio, suspended]);

  const selectBox = useCallback((boxId: string | null) => {
    setDomain((state) => {
      const next = domainReducer(state, { type: 'box/select', boxId });
      domainRef.current = next;
      return next;
    });
    setPendingDomain((state) =>
      state ? domainReducer(state, { type: 'box/select', boxId }) : null,
    );
  }, []);

  const commit = useCallback(
    async (command: DomainCommand, reason: MutationReason) => {
      if (!editable || pendingExpectedRef.current !== null) {
        setMutationError(
          host.locked
            ? 'This prediction or annotation is read-only.'
            : 'Wait for the current save to finish.',
        );
        return false;
      }
      let next: DomainState;
      try {
        next = domainReducer(domainRef.current, command);
      } catch (error) {
        setMutationError(readError(error));
        return false;
      }
      if (next === domainRef.current || next.revision === domainRef.current.revision) {
        domainRef.current = next;
        setDomain(next);
        return true;
      }
      const epoch = host.epoch;
      pendingExpectedRef.current = 'pending';
      setPendingDomain(next);
      setMutationError('');
      try {
        await annotationPort.replaceDocument(next.document, reason);
        if (annotationPort.getEpoch() !== epoch) return false;
        domainRef.current = next;
        setDomain(next);
        setPendingDomain(null);
        pendingExpectedRef.current = null;
        setHostStatus(annotationPort.getStatus());
        setAnnouncement(
          mode === 'embedded'
            ? `${humanizeReason(reason)} updated in the current Label Studio annotation. Use outer Submit/Update to persist it.`
            : `${humanizeReason(reason)} updated in memory.`,
        );
        return true;
      } catch (error) {
        if (annotationPort.getEpoch() === epoch) {
          setPendingDomain(null);
          pendingExpectedRef.current = null;
          setMutationError(readError(error));
          setHostStatus(annotationPort.getStatus());
        }
        return false;
      }
    },
    [annotationPort, editable, host.epoch, host.locked, mode],
  );

  const togglePlay = useCallback(() => {
    if (!audio) return;
    if (audio.element.paused)
      void audio.element.play().catch((error) => setAudioError(readError(error)));
    else audio.element.pause();
  }, [audio]);

  const stepPlaybackRate = useCallback(
    (direction: -1 | 1) => {
      if (!audio) return;
      const index = PLAYBACK_RATES.indexOf(playbackRate as (typeof PLAYBACK_RATES)[number]);
      const nextIndex = Math.max(0, Math.min(PLAYBACK_RATES.length - 1, index + direction));
      const next = PLAYBACK_RATES[nextIndex];
      if (assignPlaybackRate(audio.element, next)) setPlaybackRate(next);
      else {
        assignPlaybackRate(audio.element, playbackRate);
        setAudioError(`This browser rejected ${next}× playback; restored ${playbackRate}×.`);
      }
    },
    [audio, playbackRate],
  );

  const deleteSelected = useCallback(() => {
    if (!visualDomain.selectedBoxId) return;
    void commit({ type: 'box/delete', boxId: visualDomain.selectedBoxId }, 'box/delete');
  }, [commit, visualDomain.selectedBoxId]);

  const zoom = useCallback(
    (factor: number) => {
      setView((current) => {
        const center = (current.timeStartSeconds + current.timeEndSeconds) / 2;
        const half = Math.max(
          0.125,
          Math.min(
            current.durationSeconds / 2,
            (current.timeEndSeconds - current.timeStartSeconds) / (2 * factor),
          ),
        );
        let start = center - half;
        let end = center + half;
        if (start < 0) {
          end -= start;
          start = 0;
        }
        if (end > current.durationSeconds) {
          start -= end - current.durationSeconds;
          end = current.durationSeconds;
        }
        return {
          ...current,
          timeStartSeconds: Math.max(0, start),
          timeEndSeconds: Math.min(current.durationSeconds, end),
        };
      });
      onSemanticEvent('viewport.zoomed');
    },
    [onSemanticEvent],
  );

  const pan = useCallback((deltaSeconds: number) => {
    setView((current) => {
      const span = current.timeEndSeconds - current.timeStartSeconds;
      const start = Math.max(
        0,
        Math.min(current.durationSeconds - span, current.timeStartSeconds + deltaSeconds),
      );
      return { ...current, timeStartSeconds: start, timeEndSeconds: start + span };
    });
  }, []);

  const fitView = useCallback(() => {
    if (!audio) return;
    setView({
      durationSeconds: audio.durationSeconds,
      maximumFrequencyHz: audio.maximumFrequencyHz,
      timeStartSeconds: 0,
      timeEndSeconds: audio.durationSeconds,
      lowFrequencyHz: 0,
      highFrequencyHz: audio.maximumFrequencyHz,
    });
    onSemanticEvent('viewport.fit');
  }, [audio, onSemanticEvent]);

  const markNoCalls = useCallback(() => {
    if (!audio || audioPhase !== 'ready') return;
    if (
      boxes.length > 0 &&
      !window.confirm('Clear all boxes and mark this recording as containing no calls?')
    )
      return;
    void commit({ type: 'review/setNoCalls' }, 'review/setNoCalls');
  }, [audio, audioPhase, boxes.length, commit]);

  const cycleOverlap = useCallback(
    (direction: -1 | 1) => {
      if (tool !== 'select' || boxes.length < 2) return;
      const selected = boxes.find((box) => box.id === visualDomain.selectedBoxId);
      if (!selected) return;
      const stack = boxes
        .filter((box) => boxesOverlap(selected, box))
        .map((box) => box.id)
        .sort();
      if (stack.length < 2) return;
      const index = stack.indexOf(selected.id);
      selectBox(stack[(index + direction + stack.length) % stack.length]);
    },
    [boxes, selectBox, tool, visualDomain.selectedBoxId],
  );

  const runCommand = useCallback(
    (command: WorkspaceCommandId) => {
      switch (command) {
        case 'panel.species':
          setPanels((value) => ({ ...value, species: !value.species }));
          break;
        case 'panel.details':
          setPanels((value) => ({ ...value, details: !value.details }));
          break;
        case 'panel.display':
          setPanels((value) => ({ ...value, display: !value.display }));
          break;
        case 'panel.dataset':
          setPanels((value) => ({ ...value, dataset: !value.dataset }));
          break;
        case 'tool.draw':
          if (!spectrogramReady) {
            setAnnouncement('Building spectrogram… Draw is available after the first frame.');
            break;
          }
          setTool('draw');
          onSemanticEvent('tool.draw');
          break;
        case 'tool.select':
          setTool('select');
          onSemanticEvent('tool.select');
          break;
        case 'tool.pan':
          setTool('pan');
          break;
        case 'audio.playPause':
          if (spectrogramReady) togglePlay();
          break;
        case 'audio.faster':
          stepPlaybackRate(1);
          break;
        case 'audio.slower':
          stepPlaybackRate(-1);
          break;
        case 'viewport.zoomIn':
          zoom(1.6);
          break;
        case 'viewport.zoomOut':
          zoom(0.625);
          break;
        case 'box.delete':
          deleteSelected();
          break;
        case 'gesture.cancel':
          setGestureCancelVersion((version) => version + 1);
          selectBox(null);
          setTool('select');
          break;
        case 'selection.cycleForward':
          cycleOverlap(1);
          break;
        case 'selection.cycleBackward':
          cycleOverlap(-1);
          break;
        case 'review.noCalls':
          markNoCalls();
          break;
        case 'history.undo':
          void commit({ type: 'history/undo' }, 'history/undo');
          break;
        case 'history.redo':
          void commit({ type: 'history/redo' }, 'history/redo');
          break;
      }
    },
    [
      commit,
      cycleOverlap,
      deleteSelected,
      markNoCalls,
      onSemanticEvent,
      selectBox,
      spectrogramReady,
      stepPlaybackRate,
      togglePlay,
      zoom,
    ],
  );

  useEffect(() => {
    if (suspended) return;
    const handler = (event: KeyboardEvent) => {
      const command = commandForKeyboardEvent(event);
      if (!command) return;
      event.preventDefault();
      runCommand(command);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [runCommand, suspended]);

  useEffect(() => {
    if (tutorialStep === undefined) return;
    const practiceBox = boxes[0];
    if (tutorialStep === 6) {
      // Soft recovery: if the learner advanced without selecting the tool,
      // make the resize step safe without grading or blocking progress.
      setTool('select');
      if (practiceBox) selectBox(practiceBox.id);
    }
    if (tutorialStep === 7) {
      setPanels((current) =>
        current.details && current.dataset ? current : { ...current, details: true, dataset: true },
      );
      if (practiceBox) selectBox(practiceBox.id);
      fitView();
    }
    if (tutorialStep === 9) {
      setPanels((current) => (current.species ? current : { ...current, species: true }));
    }
  }, [boxes, fitView, selectBox, tutorialStep]);

  const addSpecies = async (input: {
    code: string;
    speciesName: string;
    scientificName?: string;
  }) => {
    try {
      const species = await catalogPort.create(input);
      const nextCatalog = await catalogPort.read();
      setCatalog(nextCatalog);
      onCatalogChanged?.(nextCatalog);
      setCurrentSpeciesId(species.speciesId);
      setTool('draw');
      const scopeMessage =
        speciesCreateScope === 'annotation'
          ? 'Added to this annotation. The project lead can include it in a later project catalog update.'
          : speciesCreateScope === 'project'
            ? 'Added to this project catalog. Other annotators will see it on their next catalog refresh.'
            : 'Added to this page session and selected.';
      setAnnouncement(
        `${species.code} — ${species.speciesName} added and selected. ${scopeMessage}`,
      );
      onSemanticEvent('species.added', species.speciesId);
      return '';
    } catch (error) {
      return readError(error);
    }
  };

  const hostError =
    hostStatus.phase === 'error'
      ? [hostStatus.error?.message, hostStatus.error?.repair].filter(Boolean).join(' ')
      : '';
  const interfacePhase =
    catalogError || audioError || hostError
      ? 'error'
      : audioPhase === 'loading' || !catalog
        ? 'loading'
        : 'ready';
  const readyPersistenceLabel =
    persistenceLabel ??
    (mode === 'embedded'
      ? 'Current Label Studio annotation updated'
      : mode === 'local'
        ? 'No JSON prepared'
        : 'Demo memory only');

  return (
    <main
      className={`froglabel-app ${dark ? 'theme-dark' : 'theme-light'}`}
      data-audio-phase={audioPhase === 'loading' ? 'decoding' : audioPhase}
      data-spectrogram-state={spectrogramPhase}
    >
      <header className="app-header">
        <div className="brand-lockup">
          <img src={logo} alt="" className="brand-frog" />
          <div>
            <h1>FrogLabel</h1>
            <span>
              {mode === 'embedded'
                ? 'Label Studio workspace'
                : mode === 'local'
                  ? 'Private local workspace'
                  : 'Browser workflow demo'}
            </span>
          </div>
        </div>
        <div className="header-actions">
          {headerExtras}
          <span
            className={`save-status status-${hostStatus.phase}`}
            aria-label={`Persistence status: ${hostStatus.phase}`}
          >
            {hostStatus.phase === 'saving' || pendingDomain
              ? 'Saving…'
              : hostStatus.phase === 'read-only'
                ? 'Read-only'
                : hostStatus.phase === 'error'
                  ? 'Host error'
                  : readyPersistenceLabel}
          </span>
          <button
            type="button"
            className="icon-button theme-button"
            onClick={() => setDark((value) => !value)}
            aria-label="Toggle light and dark theme"
          >
            {dark ? 'Light' : 'Dark'}
          </button>
          <button
            ref={helpButtonRef}
            type="button"
            className="help-button"
            onClick={onHelp}
            aria-label="Help and tutorial"
            data-tutorial="help"
          >
            ?
          </button>
        </div>
      </header>

      <div
        className="workspace-toolbar"
        aria-label="Annotation toolbar"
        data-tutorial-essential="toolbar"
      >
        <button
          type="button"
          className={isPlaying ? 'active' : ''}
          onClick={() => runCommand('audio.playPause')}
          disabled={!audio || !spectrogramReady}
          data-tutorial="play"
          aria-pressed={isPlaying}
        >
          {isPlaying ? 'Pause' : 'Play Audio'} <kbd>Space</kbd>
        </button>
        <button
          type="button"
          onClick={() => runCommand('audio.slower')}
          disabled={!audio || !spectrogramReady || playbackRate === PLAYBACK_RATES[0]}
          aria-label="Slower playback (less-than key)"
        >
          Slower
        </button>
        <output className="playback-rate" aria-label="Playback rate">
          {playbackRate}×
        </output>
        <button
          type="button"
          onClick={() => runCommand('audio.faster')}
          disabled={!audio || !spectrogramReady || playbackRate === PLAYBACK_RATES.at(-1)}
          aria-label="Faster playback (greater-than key)"
        >
          Faster
        </button>
        <button
          type="button"
          className={tool === 'select' ? 'active' : ''}
          onClick={() => runCommand('tool.select')}
          aria-pressed={tool === 'select'}
          data-tutorial="select"
        >
          Select <kbd>V</kbd>
        </button>
        <button
          type="button"
          className={tool === 'draw' ? 'active' : ''}
          onClick={() => runCommand('tool.draw')}
          aria-pressed={tool === 'draw'}
          data-tutorial="draw"
          disabled={!spectrogramReady}
        >
          Draw Box <kbd>D</kbd>
        </button>
        <button
          type="button"
          className={tool === 'pan' ? 'active' : ''}
          onClick={() => runCommand('tool.pan')}
          aria-pressed={tool === 'pan'}
        >
          Pan <kbd>P</kbd>
        </button>
        <div className="toolbar-separator" />
        <button
          type="button"
          onClick={() => zoom(1.6)}
          disabled={!audio}
          data-tutorial="zoom"
          aria-label="Zoom in spectrogram"
        >
          + Zoom
        </button>
        <button
          type="button"
          onClick={() => zoom(0.625)}
          disabled={!audio}
          aria-label="Zoom out spectrogram"
        >
          - Zoom
        </button>
        <button
          type="button"
          onClick={() => pan(-(view.timeEndSeconds - view.timeStartSeconds) * 0.25)}
          disabled={!audio}
          aria-label="Pan left"
        >
          &lt; Pan
        </button>
        <button
          type="button"
          onClick={() => pan((view.timeEndSeconds - view.timeStartSeconds) * 0.25)}
          disabled={!audio}
          aria-label="Pan right"
        >
          Pan &gt;
        </button>
        <button
          type="button"
          onClick={fitView}
          disabled={!audio}
          aria-label="Reset and fit spectrogram view"
        >
          Reset / Fit
        </button>
        <button
          type="button"
          onClick={() => runCommand('box.delete')}
          disabled={!selectedBox || !editable}
        >
          Delete box <kbd>Del</kbd>
        </button>
        <button
          type="button"
          onClick={() => runCommand('history.undo')}
          disabled={!editable || domain.undo.length === 0}
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => runCommand('history.redo')}
          disabled={!editable || domain.redo.length === 0}
        >
          Redo
        </button>
        <button
          type="button"
          className={visualDomain.document?.reviewStatus === 'no_calls' ? 'active' : ''}
          onClick={markNoCalls}
          disabled={!editable || !audio}
          aria-pressed={visualDomain.document?.reviewStatus === 'no_calls'}
          aria-label="No calls present (Shift+N)"
          data-tutorial="no-calls"
        >
          No calls present <kbd>Shift+N</kbd>
        </button>
        <div className="panel-shortcuts" aria-label="Panels">
          {(['species', 'details', 'display', 'dataset'] as const).map((panel, index) => (
            <button
              key={panel}
              type="button"
              className={panels[panel] ? 'active' : ''}
              aria-pressed={panels[panel]}
              onClick={() => runCommand(`panel.${panel}` as WorkspaceCommandId)}
              aria-expanded={panels[panel]}
            >
              {index + 1} {panel[0].toUpperCase() + panel.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="workspace-grid">
        {panels.species && (
          <aside className="panel species-panel" aria-label="Species catalog panel">
            <PanelHeading number="1" title="Species" />
            {catalog ? (
              <SpeciesPicker
                catalog={catalog}
                value={currentSpeciesId}
                onChange={(id) => {
                  setCurrentSpeciesId(id);
                  if (id) onSemanticEvent('species.selected', id);
                }}
                canCreate={catalogPort.canCreate()}
                onAdd={addSpecies}
                onRefresh={() => refreshCatalog()}
                onOpenAdd={() => onSemanticEvent('species.formOpened')}
              />
            ) : (
              <p className="muted">Loading project catalog…</p>
            )}
          </aside>
        )}

        <section className="spectrogram-column" aria-label="Audio annotation workspace">
          <div className="audio-summary">
            <div>
              <strong>{audio?.source.filename ?? 'Waiting for audio'}</strong>
              {audio && (
                <span>
                  {formatSeconds(audio.durationSeconds)} · decoded{' '}
                  {Math.round(audio.analysis.sampleRateHz).toLocaleString()} Hz analysis ·{' '}
                  {audio.channelCount === 1 ? 'mono' : 'native stereo playback'} ·{' '}
                  {audio.decoder === 'source-faithful-wav'
                    ? 'source-faithful PCM'
                    : 'browser-decoded range'}
                </span>
              )}
            </div>
            <label className="species-quick">
              Current species
              <select
                value={currentSpeciesId}
                onChange={(event) => {
                  setCurrentSpeciesId(event.target.value);
                  if (event.target.value) onSemanticEvent('species.selected', event.target.value);
                }}
                disabled={!catalog}
              >
                <option value="">No species selected</option>
                {catalog?.species.map((entry) => (
                  <option key={entry.speciesId} value={entry.speciesId}>
                    {entry.code} — {entry.speciesName}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="spectrogram-frame">
            {interfacePhase === 'loading' && (
              <StateNotice
                title={audioPhase === 'loading' ? 'Decoding audio once…' : 'Loading workspace…'}
              />
            )}
            {interfacePhase === 'error' && (
              <StateNotice
                title="Workspace needs attention"
                detail={catalogError || audioError || hostError}
                error
              />
            )}
            {interfacePhase === 'ready' && !audio && (
              <StateNotice
                title="Waiting for audio"
                detail={
                  mode === 'local'
                    ? 'The spectrogram will appear here after an audio file is opened.'
                    : 'The host has not supplied an audio file yet.'
                }
              >
                {emptyAudioState}
              </StateNotice>
            )}
            {interfacePhase === 'ready' && audio && (
              <>
                <SpectrogramCanvas
                  audio={audio}
                  boxes={host.hidden ? [] : boxes}
                  selectedBoxId={host.hidden ? null : visualDomain.selectedBoxId}
                  tool={tool}
                  canDraw={Boolean(currentSpecies) && spectrogramReady}
                  disabled={!hostEditable || Boolean(pendingDomain) || host.hidden || suspended}
                  view={view}
                  settings={settings}
                  playheadSeconds={playhead}
                  cancelVersion={gestureCancelVersion}
                  onSelect={selectBox}
                  onCreate={(geometry) =>
                    currentSpecies
                      ? commit(
                          {
                            type: 'box/createCommitted',
                            species: currentSpecies,
                            geometry,
                            id: createStableId('box'),
                            timestamp: new Date().toISOString(),
                          },
                          'box/createCommitted',
                        )
                      : Promise.resolve(false)
                  }
                  onResize={(boxId, geometry) =>
                    commit(
                      {
                        type: 'box/resizeCommitted',
                        boxId,
                        geometry,
                        timestamp: new Date().toISOString(),
                      },
                      'box/resizeCommitted',
                    )
                  }
                  onPan={pan}
                  onError={setMutationError}
                  onSemanticEvent={onSemanticEvent}
                  onLifecycleChange={setSpectrogramPhase}
                />
                {host.hidden && (
                  <div className="hidden-annotation-notice" role="status">
                    Annotations hidden by Label Studio
                  </div>
                )}
              </>
            )}
            {audio && <div className="playhead-readout">Playhead {playhead.toFixed(2)}s</div>}
          </div>

          {!visualDomain.document && interfacePhase === 'ready' && audio && (
            <div className="empty-annotation">
              <span>Unreviewed — no scientific decision has been recorded.</span>
              <button
                type="button"
                onClick={markNoCalls}
                disabled={!editable || audioPhase !== 'ready'}
              >
                Mark “No calls present”
              </button>
            </div>
          )}
          {visualDomain.document?.reviewStatus === 'no_calls' && (
            <div className="empty-annotation no-calls-active" role="status">
              <span>✓ Reviewed: no calls present</span>
              <button
                type="button"
                disabled={!editable}
                onClick={() => void commit({ type: 'review/clear' }, 'review/clear')}
              >
                Return to unreviewed
              </button>
            </div>
          )}

          {panels.dataset && (
            <DatasetTable
              boxes={host.hidden ? [] : boxes}
              selectedBoxId={visualDomain.selectedBoxId}
              onSelect={(id) => {
                selectBox(id);
                onSemanticEvent('box.selected', id);
              }}
              onDelete={(id) => void commit({ type: 'box/delete', boxId: id }, 'box/delete')}
              disabled={!editable}
            />
          )}
        </section>

        {(panels.details || panels.display) && (
          <aside className="panel right-panel">
            {panels.details && (
              <DetailsPanel
                key={`${selectedBox?.id ?? 'none'}:${selectedBox?.updatedAt ?? ''}`}
                box={host.hidden ? null : selectedBox}
                catalog={catalog}
                disabled={!editable}
                onAssign={(species) =>
                  selectedBox &&
                  void commit(
                    {
                      type: 'species/assign',
                      boxId: selectedBox.id,
                      species,
                      timestamp: new Date().toISOString(),
                    },
                    'species/assign',
                  )
                }
                onGeometry={(geometry) =>
                  selectedBox &&
                  void commit(
                    {
                      type: 'box/resizeCommitted',
                      boxId: selectedBox.id,
                      geometry,
                      timestamp: new Date().toISOString(),
                    },
                    'box/resizeCommitted',
                  )
                }
                onPlay={() => selectedBox && playBox(audio, selectedBox, setAudioError)}
              />
            )}
            {panels.display && (
              <DisplayPanel
                settings={settings}
                onChange={setSettings}
                view={view}
                channelCount={audio?.channelCount ?? 1}
                onMinimum={(lowFrequencyHz) =>
                  setView((current) => ({
                    ...current,
                    lowFrequencyHz: Math.min(lowFrequencyHz, current.highFrequencyHz - 1),
                  }))
                }
                onCutoff={(highFrequencyHz) =>
                  setView((current) => ({
                    ...current,
                    highFrequencyHz: Math.max(highFrequencyHz, current.lowFrequencyHz + 1),
                  }))
                }
              />
            )}
          </aside>
        )}
      </div>

      <div className="sr-live" aria-live="polite">
        {announcement || tutorialMessage}
      </div>
      {(mutationError || catalogError || audioError || hostError) && (
        <div className="error-toast" role="alert">
          {mutationError || catalogError || audioError || hostError}
          {mutationError && !catalogError && !audioError && !hostError ? (
            <button type="button" onClick={() => setMutationError('')} aria-label="Dismiss error">
              ×
            </button>
          ) : (
            <button type="button" onClick={() => window.location.reload()}>
              Reload workspace
            </button>
          )}
        </div>
      )}
    </main>
  );
}

function SpeciesPicker({
  catalog,
  value,
  onChange,
  canCreate,
  onAdd,
  onRefresh,
  onOpenAdd,
}: {
  catalog: SpeciesCatalogV1;
  value: string;
  onChange(value: string): void;
  canCreate: boolean;
  onAdd(input: { code: string; speciesName: string; scientificName?: string }): Promise<string>;
  onRefresh(): Promise<void>;
  onOpenAdd(): void;
}) {
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [scientificName, setScientificName] = useState('');
  const [error, setError] = useState('');
  const normalized = search.normalize('NFKC').trim().toLocaleLowerCase();
  const visible = catalog.species.filter((entry) =>
    [entry.code, entry.speciesName, entry.scientificName ?? ''].some((part) =>
      part.toLocaleLowerCase().includes(normalized),
    ),
  );
  return (
    <div className="species-picker" data-tutorial="species">
      <label>
        Search
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onFocus={() => void onRefresh()}
          placeholder="Code or species name"
        />
      </label>
      <div className="species-list" role="listbox" aria-label="Project species">
        {visible.map((entry) => (
          <button
            key={entry.speciesId}
            type="button"
            role="option"
            aria-selected={value === entry.speciesId}
            className={value === entry.speciesId ? 'selected' : ''}
            onClick={() => onChange(entry.speciesId)}
          >
            <strong>{entry.code}</strong>
            <span>{entry.speciesName}</span>
          </button>
        ))}
        {visible.length === 0 && (
          <p className="muted">
            {catalog.species.length === 0
              ? 'No species yet. Listen and navigate, then add the first species before drawing.'
              : 'No matching project species.'}
          </p>
        )}
      </div>
      <button
        type="button"
        className="add-species-trigger"
        data-tutorial="add-species"
        onClick={() =>
          setAdding((value) => {
            if (!value) onOpenAdd();
            return !value;
          })
        }
        disabled={!canCreate}
      >
        + Add missing species
      </button>
      {!canCreate && (
        <p className="permission-note">
          Your project role can use existing species but cannot add one.
        </p>
      )}
      {adding && (
        <form
          className="add-species-form"
          data-tutorial-essential="add-species-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const result = await onAdd({
              code,
              speciesName: name,
              ...(scientificName ? { scientificName } : {}),
            });
            setError(result);
            if (!result) {
              setAdding(false);
              setCode('');
              setName('');
              setScientificName('');
            }
          }}
        >
          <label>
            Three-letter code
            <input
              value={code}
              maxLength={3}
              pattern="[A-Za-z]{3}"
              required
              onChange={(event) =>
                setCode(event.target.value.toUpperCase().replace(/[^A-Z]/gu, ''))
              }
              placeholder="GRE"
            />
          </label>
          <label>
            Full Species Name
            <input
              value={name}
              maxLength={256}
              required
              onChange={(event) => setName(event.target.value)}
              placeholder="Green Tree Frog"
            />
          </label>
          <label>
            Scientific name <span>(optional)</span>
            <input
              value={scientificName}
              maxLength={256}
              onChange={(event) => setScientificName(event.target.value)}
            />
          </label>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="submit">Save species</button>
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function DetailsPanel({
  box,
  catalog,
  disabled,
  onAssign,
  onGeometry,
  onPlay,
}: {
  box: FrogLabelBoxV1 | null;
  catalog: SpeciesCatalogV1 | null;
  disabled: boolean;
  onAssign(species: SpeciesEntryV1): void;
  onGeometry(
    geometry: Pick<
      FrogLabelBoxV1,
      'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
    >,
  ): void;
  onPlay(): void;
}) {
  const [draft, setDraft] = useState(() => geometryDraft(box));
  useEffect(() => {
    setDraft(geometryDraft(box));
  }, [box]);
  const changeDraft = (field: GeometryField, value: string) =>
    setDraft((current) => ({
      ...current,
      [field]: value,
      touched: { ...current.touched, [field]: true },
    }));
  return (
    <section data-tutorial="details">
      <PanelHeading number="2" title="Box Details" />
      {!box ? (
        <p className="muted">
          Select any existing box to inspect it—even when no current species is selected.
        </p>
      ) : (
        <div className="details-grid">
          <div className="species-summary">
            <strong>{box.species.code}</strong>
            <span>{box.species.speciesName}</span>
          </div>
          <label>
            Reassign species
            <select
              value={box.species.speciesId}
              disabled={disabled}
              onChange={(event) => {
                const species = catalog?.species.find(
                  (entry) => entry.speciesId === event.target.value,
                );
                if (species) onAssign(species);
              }}
            >
              {catalog?.species.map((entry) => (
                <option key={entry.speciesId} value={entry.speciesId}>
                  {entry.code} — {entry.speciesName}
                </option>
              ))}
            </select>
          </label>
          <div className="geometry-fields">
            <NumberField
              label="Start (s)"
              value={draft.start}
              step="0.001"
              onChange={(start) => changeDraft('start', start)}
            />
            <NumberField
              label="End (s)"
              value={draft.end}
              step="0.001"
              onChange={(end) => changeDraft('end', end)}
            />
            <NumberField
              label="Low (Hz)"
              value={draft.low}
              step="1"
              onChange={(low) => changeDraft('low', low)}
            />
            <NumberField
              label="High (Hz)"
              value={draft.high}
              step="1"
              onChange={(high) => changeDraft('high', high)}
            />
          </div>
          <p>
            Duration <strong>{(box.endTimeSeconds - box.startTimeSeconds).toFixed(3)} s</strong>
          </p>
          <p>
            Bandwidth <strong>{Math.round(box.highFrequencyHz - box.lowFrequencyHz)} Hz</strong>
          </p>
          <p>
            Origin{' '}
            <strong>
              {box.provenance.source === 'model'
                ? `${box.provenance.model.name} ${box.provenance.model.version}${box.provenance.humanModified ? ' · human modified' : ''}`
                : 'Human'}
            </strong>
          </p>
          {box.provenance.source === 'model' && (
            <details>
              <summary>
                Model evidence
                {box.provenance.confidence === undefined
                  ? ''
                  : ` · ${(box.provenance.confidence * 100).toFixed(1)}%`}
              </summary>
              <p>
                Source detection: <code>{box.provenance.sourceDetectionId}</code>
              </p>
              <ul>
                {box.provenance.candidates.map((candidate) => (
                  <li key={`${candidate.rawClass}:${candidate.mappedSpeciesId ?? ''}`}>
                    {candidate.rawClass}
                    {candidate.score === undefined ? '' : ` (${candidate.score.toFixed(3)})`}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="form-actions">
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onGeometry({
                  startTimeSeconds: draft.touched.start
                    ? Number(draft.start)
                    : box.startTimeSeconds,
                  endTimeSeconds: draft.touched.end ? Number(draft.end) : box.endTimeSeconds,
                  lowFrequencyHz: draft.touched.low ? Number(draft.low) : box.lowFrequencyHz,
                  highFrequencyHz: draft.touched.high ? Number(draft.high) : box.highFrequencyHz,
                })
              }
            >
              Update geometry
            </button>
            <button type="button" onClick={onPlay}>
              Play selected box
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function DisplayPanel({
  settings,
  onChange,
  view,
  channelCount,
  onMinimum,
  onCutoff,
}: {
  settings: {
    fftSamples: number;
    overlapPercent: number;
    brightness: number;
    contrast: number;
    palette: SpectrogramPalette;
    channelMode: AnalysisChannelMode;
    frequencyScale: FrequencyScale;
  };
  onChange(value: typeof settings): void;
  view: { maximumFrequencyHz: number; lowFrequencyHz: number; highFrequencyHz: number };
  channelCount: number;
  onMinimum(value: number): void;
  onCutoff(value: number): void;
}) {
  return (
    <section className="display-panel">
      <PanelHeading number="3" title="Spectrogram" />
      <label>
        Palette
        <select
          value={settings.palette}
          onChange={(event) =>
            onChange({ ...settings, palette: event.target.value as SpectrogramPalette })
          }
        >
          <option value="viridis">Viridis</option>
          <option value="magma">Magma</option>
          <option value="inferno">Inferno</option>
          <option value="plasma">Plasma</option>
          <option value="grayscale">Grayscale</option>
        </select>
      </label>
      <p className="muted">Complete ~20 ms Hann analysis · 75% overlap · fixed −120 dBFS floor</p>
      {channelCount > 1 ? (
        <label>
          Analysis channel
          <select
            value={settings.channelMode}
            title="Average mixdown averages channel energy so opposite-phase calls are not erased."
            onChange={(event) =>
              onChange({ ...settings, channelMode: event.target.value as AnalysisChannelMode })
            }
          >
            <option value="average">Average mixdown</option>
            <option value="max">Max</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
      ) : (
        <p className="muted">Analysis channel: Mono</p>
      )}
      <label>
        Frequency scale
        <select
          value={settings.frequencyScale}
          onChange={(event) => {
            const frequencyScale = event.target.value as FrequencyScale;
            onChange({ ...settings, frequencyScale });
            if (frequencyScale === 'logarithmic' && view.lowFrequencyHz === 0) onMinimum(20);
          }}
        >
          <option value="linear">Linear</option>
          <option value="logarithmic">Logarithmic</option>
        </select>
      </label>
      <label>
        Brightness <output>{settings.brightness.toFixed(1)}×</output>
        <input
          type="range"
          min="0.4"
          max="2.5"
          step="0.1"
          value={settings.brightness}
          onChange={(event) => onChange({ ...settings, brightness: Number(event.target.value) })}
        />
      </label>
      <label>
        Contrast <output>{settings.contrast.toFixed(1)}×</output>
        <input
          type="range"
          min="0.5"
          max="2.5"
          step="0.1"
          value={settings.contrast}
          onChange={(event) => onChange({ ...settings, contrast: Number(event.target.value) })}
        />
      </label>
      <label>
        Display minimum <output>{Math.round(view.lowFrequencyHz)} Hz</output>
        <input
          type="range"
          min="0"
          max={Math.max(0, view.highFrequencyHz - 1)}
          step="10"
          value={view.lowFrequencyHz}
          onChange={(event) => onMinimum(Number(event.target.value))}
        />
      </label>
      <label>
        Display maximum <output>{Math.round(view.highFrequencyHz)} Hz</output>
        <input
          type="range"
          min="1000"
          max={view.maximumFrequencyHz}
          step="100"
          value={view.highFrequencyHz}
          onChange={(event) => onCutoff(Number(event.target.value))}
        />
      </label>
      <p className="muted">
        Settings redraw the cached decode. They never refetch audio or change annotations.
      </p>
    </section>
  );
}

function DatasetTable({
  boxes,
  selectedBoxId,
  onSelect,
  onDelete,
  disabled,
}: {
  boxes: FrogLabelBoxV1[];
  selectedBoxId: string | null;
  onSelect(id: string): void;
  onDelete(id: string): void;
  disabled: boolean;
}) {
  return (
    <section className="dataset-panel" aria-labelledby="dataset-heading">
      <PanelHeading number="4" title="Annotation Dataset" id="dataset-heading" />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Species</th>
              <th scope="col">Start (s)</th>
              <th scope="col">End (s)</th>
              <th scope="col">Low (Hz)</th>
              <th scope="col">High (Hz)</th>
              <th scope="col">Bandwidth (Hz)</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {boxes.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-cell">
                  No boxes. Draw one, or explicitly mark No calls present.
                </td>
              </tr>
            ) : (
              boxes.map((box) => (
                <tr
                  key={box.id}
                  className={selectedBoxId === box.id ? 'selected' : ''}
                  onClick={() => onSelect(box.id)}
                >
                  <th scope="row">
                    <button type="button" onClick={() => onSelect(box.id)}>
                      {box.species.code} — {box.species.speciesName}
                    </button>
                  </th>
                  <td>{box.startTimeSeconds.toFixed(3)}</td>
                  <td>{box.endTimeSeconds.toFixed(3)}</td>
                  <td>{Math.round(box.lowFrequencyHz)}</td>
                  <td>{Math.round(box.highFrequencyHz)}</td>
                  <td>{Math.round(box.highFrequencyHz - box.lowFrequencyHz)}</td>
                  <td>
                    <button
                      type="button"
                      className="delete-row"
                      aria-label={`Delete ${box.species.code} box`}
                      disabled={disabled}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDelete(box.id);
                      }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HelpDialog({
  mode,
  onClose,
  onStart,
}: {
  mode: FrogLabelWorkspaceProps['mode'];
  onClose(): void;
  onStart(): void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.code !== 'Tab') return;
    const focusable = dialogRef.current
      ? [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
          (element) => !element.hasAttribute('disabled') && element.tabIndex !== -1,
        )
      : [];
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey
      ? current <= 0
        ? focusable.length - 1
        : current - 1
      : current === focusable.length - 1
        ? 0
        : current + 1;
    if (current === -1 || next !== current + (event.shiftKey ? -1 : 1)) {
      event.preventDefault();
      focusable[next]?.focus();
    }
  };
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">FrogLabel help</span>
            <h2 id="help-title">Tools and shortcuts</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close help"
          >
            ×
          </button>
        </div>
        <button type="button" className="tutorial-start" onClick={onStart}>
          Start 2-minute tutorial <span>Uses the real workspace; practice is discarded.</span>
        </button>
        <dl className="shortcut-list">
          <div>
            <dt>
              <kbd>1</kbd>–<kbd>4</kbd>
            </dt>
            <dd>Toggle Species, Details, Display, Dataset</dd>
          </div>
          <div>
            <dt>
              <kbd>D</kbd> / <kbd>V</kbd> / <kbd>P</kbd>
            </dt>
            <dd>Draw, Select, Pan</dd>
          </div>
          <div>
            <dt>
              <kbd>Space</kbd>
            </dt>
            <dd>Play/pause when no control has focus</dd>
          </div>
          <div>
            <dt>
              <kbd>Delete</kbd>
            </dt>
            <dd>Delete selected box</dd>
          </div>
          <div>
            <dt>
              <kbd>Ctrl/⌘ Z</kbd>
            </dt>
            <dd>Undo</dd>
          </div>
          <div>
            <dt>
              <kbd>Tab</kbd>
            </dt>
            <dd>Native keyboard navigation is never hijacked</dd>
          </div>
        </dl>
        <p className="help-note">
          {mode === 'embedded'
            ? 'Embedded work is saved through Label Studio’s outer Submit/Update. FrogLabel never stores a personal token or advances tasks itself.'
            : mode === 'local'
              ? 'Local work stays in this browser tab until you prepare and download JSON. Audio bytes are never included, and no server is contacted.'
              : 'This demo uses the bundled Green Tree Frog recording. Changes stay in memory and are discarded on reload.'}
        </p>
      </section>
    </div>
  );
}

function TutorialOverlay({
  step,
  tried,
  onNext,
  onBack,
  onRestart,
  onExit,
}: {
  step: number;
  tried: boolean;
  onNext(): void;
  onBack(): void;
  onRestart(): void;
  onExit(): void;
}) {
  const current = tutorialSteps[step];
  const [rect, setRect] = useState<TutorialRectangle | null>(null);
  const [coachPosition, setCoachPosition] = useState({ left: 20, top: 20 });
  const coachRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    coachRef.current?.focus();
    let animationFrame = 0;
    let scrolledAnchor: HTMLElement | null = null;
    let lastRectangle: TutorialRectangle | null = null;
    let lastPosition: { left: number; top: number } | null = null;
    const update = () => {
      const anchor = current.anchor ? visibleTutorialAnchor(current.anchor) : null;
      if (anchor && anchor !== scrolledAnchor) {
        anchor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        scrolledAnchor = anchor;
      }
      const nextRectangle = anchor ? tutorialRectangle(anchor.getBoundingClientRect()) : null;
      if (!sameTutorialRectangle(lastRectangle, nextRectangle)) {
        lastRectangle = nextRectangle;
        setRect(nextRectangle);
      }
      const coach = coachRef.current;
      if (coach) {
        const essentialRectangles = [
          ...document.querySelectorAll<HTMLElement>('[data-tutorial-essential]'),
        ]
          .filter(isVisiblyInteractiveTutorialElement)
          .map((element) => tutorialRectangle(element.getBoundingClientRect()))
          .filter((rectangle): rectangle is TutorialRectangle => rectangle !== null);
        const nextPosition = leastOverlappingCoachPosition(
          nextRectangle,
          coach,
          essentialRectangles,
        );
        if (
          !lastPosition ||
          Math.abs(nextPosition.left - lastPosition.left) > 0.5 ||
          Math.abs(nextPosition.top - lastPosition.top) > 0.5
        ) {
          lastPosition = nextPosition;
          setCoachPosition(nextPosition);
        }
      }
      animationFrame = window.requestAnimationFrame(update);
    };
    animationFrame = window.requestAnimationFrame(update);
    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [current.anchor, step]);
  return (
    <div className="tutorial-layer" aria-live="polite">
      <div className="tutorial-dim" />
      {rect && (
        <div
          className="tutorial-ring"
          style={{
            left: rect.left - 6,
            top: rect.top - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      )}
      <div
        ref={coachRef}
        className="coachmark"
        role="dialog"
        aria-label={`Tutorial step ${step + 1} of ${tutorialSteps.length}`}
        data-tutorial-step={step + 1}
        data-tutorial-anchor={current.anchor ?? 'none'}
        tabIndex={-1}
        style={{ left: coachPosition.left, top: coachPosition.top, right: 'auto', bottom: 'auto' }}
      >
        <span className="eyebrow">
          Step {step + 1} of {tutorialSteps.length}
        </span>
        <h2>{current.title}</h2>
        <p>{current.text}</p>
        {tried && <p className="tried">Tried ✓</p>}
        <div className="coach-actions">
          <button type="button" onClick={onBack} disabled={step === 0}>
            Back
          </button>
          <button type="button" onClick={onNext}>
            {step === tutorialSteps.length - 1 ? 'Finish' : 'Next'} <kbd>Space</kbd>
          </button>
          <button type="button" onClick={onExit}>
            Exit tutorial <kbd>Esc</kbd>
          </button>
          <button type="button" onClick={onRestart}>
            Restart
          </button>
        </div>
      </div>
    </div>
  );
}

interface TutorialRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function visibleTutorialAnchor(name: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>(`[data-tutorial="${name}"]`)].find((candidate) => {
      if (!isVisiblyInteractiveTutorialElement(candidate)) return false;
      const rectangle = candidate.getBoundingClientRect();
      return (
        rectangle.width > 0 &&
        rectangle.height > 0 &&
        rectangle.right > 0 &&
        rectangle.bottom > 0 &&
        rectangle.left < window.innerWidth &&
        rectangle.top < window.innerHeight
      );
    }) ?? null
  );
}

function isVisiblyInteractiveTutorialElement(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[inert]')) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function tutorialRectangle(rectangle: DOMRect): TutorialRectangle | null {
  if (!Number.isFinite(rectangle.width) || rectangle.width <= 0 || rectangle.height <= 0)
    return null;
  return {
    left: rectangle.left,
    top: rectangle.top,
    right: rectangle.right,
    bottom: rectangle.bottom,
    width: rectangle.width,
    height: rectangle.height,
  };
}

function sameTutorialRectangle(
  left: TutorialRectangle | null,
  right: TutorialRectangle | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    Math.abs(left.left - right.left) <= 0.5 &&
    Math.abs(left.top - right.top) <= 0.5 &&
    Math.abs(left.width - right.width) <= 0.5 &&
    Math.abs(left.height - right.height) <= 0.5
  );
}

function leastOverlappingCoachPosition(
  target: TutorialRectangle | null,
  coach: HTMLElement,
  essentialRectangles: readonly TutorialRectangle[],
): { left: number; top: number } {
  const margin = 16;
  const gap = 14;
  const width = coach.offsetWidth;
  const height = coach.offsetHeight;
  const maximumLeft = Math.max(margin, window.innerWidth - width - margin);
  const maximumTop = Math.max(margin, window.innerHeight - height - margin);
  const clampPosition = (left: number, top: number) => ({
    left: Math.max(margin, Math.min(maximumLeft, left)),
    top: Math.max(margin, Math.min(maximumTop, top)),
  });
  const candidates = [
    clampPosition(margin, margin),
    clampPosition(maximumLeft, margin),
    clampPosition(margin, maximumTop),
    clampPosition(maximumLeft, maximumTop),
    ...(target
      ? [
          clampPosition(target.right + gap, target.top),
          clampPosition(target.left - width - gap, target.top),
          clampPosition(target.left, target.bottom + gap),
          clampPosition(target.left, target.top - height - gap),
        ]
      : []),
  ];
  const overlapArea = (position: { left: number; top: number }, rectangle: TutorialRectangle) => {
    return (
      Math.max(
        0,
        Math.min(position.left + width, rectangle.right) - Math.max(position.left, rectangle.left),
      ) *
      Math.max(
        0,
        Math.min(position.top + height, rectangle.bottom) - Math.max(position.top, rectangle.top),
      )
    );
  };
  const overlapScore = (position: { left: number; top: number }) =>
    (target ? overlapArea(position, target) * 1_000 : 0) +
    essentialRectangles.reduce((total, rectangle) => total + overlapArea(position, rectangle), 0);
  return candidates.reduce((best, candidate) =>
    overlapScore(candidate) < overlapScore(best) ? candidate : best,
  );
}

function PanelHeading({ number, title, id }: { number: string; title: string; id?: string }) {
  return (
    <div className="panel-heading">
      <span>{number}</span>
      <h2 id={id}>{title}</h2>
    </div>
  );
}
function StateNotice({
  title,
  detail,
  error = false,
  children,
}: {
  title: string;
  detail?: string;
  error?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`state-notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
      <div className="state-icon">{error ? '!' : '...'}</div>
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {children}
    </div>
  );
}
function NumberField({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: string;
  step: string;
  onChange(value: string): void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        step={step}
        min="0"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

type GeometryField = 'start' | 'end' | 'low' | 'high';

interface GeometryDraft {
  start: string;
  end: string;
  low: string;
  high: string;
  touched: Record<GeometryField, boolean>;
}

function geometryDraft(box: FrogLabelBoxV1 | null): GeometryDraft {
  return {
    start: box ? box.startTimeSeconds.toFixed(3) : '',
    end: box ? box.endTimeSeconds.toFixed(3) : '',
    low: box ? String(Math.round(box.lowFrequencyHz)) : '',
    high: box ? String(Math.round(box.highFrequencyHz)) : '',
    touched: { start: false, end: false, low: false, high: false },
  };
}

function eventForStep(step: number): string | null {
  return (
    [
      null,
      'audio.played',
      'species.selected',
      'tool.draw',
      'box.created',
      'tool.select',
      'box.resized',
      'box.selected',
      'viewport.zoomed',
      'species.formOpened',
      null,
      null,
    ][step] ?? null
  );
}

const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

function isTutorialTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.matches('input, textarea, select, [contenteditable="true"]') ||
    Boolean(target.closest('[contenteditable="true"]'))
  );
}

function humanizeReason(reason: MutationReason): string {
  return {
    'box/createCommitted': 'Box',
    'box/resizeCommitted': 'Resize',
    'box/delete': 'Deletion',
    'species/assign': 'Species assignment',
    'review/setNoCalls': 'No-calls decision',
    'review/clear': 'Review decision',
    'history/undo': 'Undo',
    'history/redo': 'Redo',
  }[reason];
}

function sameAudioSource(
  left: AudioSourceSnapshot | null,
  right: AudioSourceSnapshot | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.url === right.url &&
      left.filename === right.filename &&
      left.mimeType === right.mimeType &&
      left.durationSeconds === right.durationSeconds &&
      left.trustedSampleRateHz === right.trustedSampleRateHz)
  );
}

function readError(error: unknown): string {
  if (error && typeof error === 'object' && 'structured' in error) {
    const structured = (
      error as { structured: { message: string; detail?: string; repair?: string } }
    ).structured;
    return [structured.message, structured.detail, structured.repair].filter(Boolean).join(' ');
  }
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}

function playBox(
  audio: LoadedAudio | null,
  box: FrogLabelBoxV1,
  onError: (message: string) => void,
): void {
  if (!audio) return;
  const resource = audio;
  const element = resource.element;
  activeRangeCleanup.get(element)?.();
  element.currentTime = box.startTimeSeconds;
  let cleaned = false;
  const interval = window.setInterval(() => stop(), 10);
  const deadline = window.setTimeout(
    () => stop(true),
    Math.max(0, ((box.endTimeSeconds - box.startTimeSeconds) / element.playbackRate) * 1000) + 25,
  );
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    element.removeEventListener('timeupdate', stop);
    element.removeEventListener('pause', cleanup);
    element.removeEventListener('ended', cleanup);
    window.clearInterval(interval);
    window.clearTimeout(deadline);
    if (activeRangeCleanup.get(element) === cleanup) {
      activeRangeCleanup.delete(element);
    }
  };
  function stop(eventOrForce: Event | boolean = false) {
    const force = eventOrForce === true;
    if (force || element.currentTime >= box.endTimeSeconds) {
      element.currentTime = Math.min(box.endTimeSeconds, resource.durationSeconds);
      element.pause();
      cleanup();
    }
  }
  element.addEventListener('timeupdate', stop);
  element.addEventListener('pause', cleanup);
  element.addEventListener('ended', cleanup);
  activeRangeCleanup.set(element, cleanup);
  void element.play().catch((error) => {
    cleanup();
    onError(readError(error));
  });
}

const activeRangeCleanup = new WeakMap<AudioPlayback, () => void>();

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function assignPlaybackRate(element: AudioPlayback, rate: number): boolean {
  if (!PLAYBACK_RATES.includes(rate as (typeof PLAYBACK_RATES)[number])) return false;
  try {
    element.playbackRate = rate;
    return element.playbackRate === rate;
  } catch {
    return false;
  }
}

function boxesOverlap(left: FrogLabelBoxV1, right: FrogLabelBoxV1): boolean {
  return (
    left.startTimeSeconds < right.endTimeSeconds &&
    left.endTimeSeconds > right.startTimeSeconds &&
    left.lowFrequencyHz < right.highFrequencyHz &&
    left.highFrequencyHz > right.lowFrequencyHz
  );
}
