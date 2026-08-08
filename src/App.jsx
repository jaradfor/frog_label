import './App.css'
import { usePanels } from './hooks/usePanels';
import Header from './components/Header'
import BoundingBoxControls from './components/BoundingBoxControls'
import WaveformSpectrogram from './components/WaveformSpectrogram'
import SpectrogramControls from './components/SpectrogramControls'
import Tools from './components/Tools'
import CodesPanel from './components/CodesPanel'
import DatasetPanel from './components/DatasetPanel'
import BoxFilePanel from './components/BoxFilePanel'
import SpectrogramPanel from './components/SpectrogramPanel'
import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useAnnotationSession } from './hooks/useAnnotationSession';
import { useSessionConfig } from './hooks/useSessionConfig';
import { useTheme } from './hooks/useTheme';
import LoginScreen from './components/LoginScreen';

function App() {
  const { config, isAuthenticated, login, logout, defaultFormValues } = useSessionConfig();

  if (!isAuthenticated) {
    return <LoginScreen defaultFormValues={defaultFormValues} onLogin={login} />;
  }

  return <AppContent config={config} onLogout={logout} />;
}

function AppContent({ config, onLogout }) {
  const { theme, setFrogTheme, lightMode, setLightMode } = useTheme();

  const { currentTask, selectedAudio, boxes, setBoxes, submitAnnotation } = useAnnotationSession(config);
  const audioFilename = selectedAudio ? selectedAudio.split('/').pop()?.split('?')[0] : null;
  const {currTool, setCurrTool} = usePanels();

  const [code, setCode] = useState('');
  const [codesDict, setCodesDict] = useState({
    'GRE': 'Green Tree Frog',
    'COR': 'Corroboree Frog',
    'SOU': 'Southern Bell Frog',
    'RED': 'Red-Eyed Tree Frog',
    'BLU': 'Blue Mountains Tree Frog',
    'POU': 'Pouched Frog',
    'GRO': 'Growling Grass Frog',
    'PER': "Peron's Tree Frog",
    'BRE': "Brereton's Frog",
    'GIA': 'Giant Burrowing Frog',
  });

  const [currSelectedBoxId, setCurrSelectedBoxId] = useState(null);
  const currSelectedIndex = boxes.findIndex(b => b.id === currSelectedBoxId);

  const [zoomX, setZoomX] = useState(1);
  const [isPlaying] = useState(false);

  const { showLeftPanel, rightPanel, showDataset } = usePanels();

  const [duration, setDuration] = useState(0);
  const [, setContainerWidth] = useState(0);
  const [drawingBox, setDrawingBox] = useState(null);

  const wavesurferRef = useRef(null);

  const togglePlayPause = useCallback(() => {
    const ws = wavesurferRef.current;
    if (!ws) return;
    ws.playPause();
  }, []);

  const [visibleTime, setVisibleTime] = useState({ start: 0, end: duration });

  const boxToRow = useCallback((box) => {
    if (!box) return null;
    const startTime = box.startTime;
    const endTime = box.endTime;
    const startFreq = box.startFreq;
    const endFreq = box.endFreq;
    return {
      ...box,
      name:      codesDict[box.code] ?? '—',
      startTime: startTime.toFixed(3),
      endTime:   endTime.toFixed(3),
      duration:  (endTime - startTime).toFixed(3),
      startFreq: Math.round(startFreq),
      endFreq:   Math.round(endFreq),
      bandwidth: Math.round(endFreq - startFreq),
    };
  }, [codesDict]);

  const rows = useMemo(() => boxes.map(boxToRow), [boxes, boxToRow]);
  const selectedRow = rows[currSelectedIndex] ?? null;
  const drawingRow = boxToRow(drawingBox);

  const [datasetHeight, setDatasetHeight] = useState(160);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  const handleDragStart = (e) => {
    isDragging.current = true;
    dragStartY.current = e.clientY;
    dragStartHeight.current = datasetHeight;
    document.body.style.cursor = 'ns-resize';
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDragging.current) return;
      const delta = dragStartY.current - e.clientY;
      const newHeight = Math.max(80, Math.min(400, dragStartHeight.current + delta));
      setDatasetHeight(newHeight);
    };
    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  return (
    <div className='flex flex-col h-screen overflow-hidden' style={{ backgroundColor: theme.background }}>
      <Header
        theme={theme}
        setFrogTheme={setFrogTheme}
        lightMode={lightMode}
        setLightMode={setLightMode}
        onSubmit={submitAnnotation}
        onLogout={onLogout}
      />

      {!currentTask && (
        <div className='flex-1 flex items-center justify-center'>
          <div className='text-center'>
            <p style={{ color: theme.text }} className='font-display text-2xl mb-4'>No Tasks Available</p>
            <p style={{ color: theme.text }} className='font-display text-sm'>All tasks have been completed or there are no tasks to annotate at this time.</p>
          </div>
        </div>
      )}

      {currentTask && (
      <div className='flex gap-2 px-2 py-2 flex-1 min-h-0 overflow-hidden items-stretch'>

        {showLeftPanel && (
          <div style={{ backgroundColor: theme.panels }} className='w-48 shrink-0 rounded-xl p-2 overflow-y-auto'>
            <CodesPanel codesDict={codesDict} setCodesDict={setCodesDict} theme={theme} />
          </div>
        )}

        <div className='flex-1 min-w-0 min-h-0 flex flex-col relative'>

          <div style={{ backgroundColor: theme.panels }} className='p-2 rounded-xl flex flex-wrap justify-center items-center gap-2'>
            <SpectrogramControls
              zoomX={zoomX}
              setZoomX={setZoomX}
              duration={duration}
              theme={theme}
              setDrawingBox={setDrawingBox}
            />
            <BoundingBoxControls
              code={code}
              setCode={setCode}
              codesDict={codesDict}
              boxes={boxes}
              setBoxes={setBoxes}
              currSelectedBoxId={currSelectedBoxId}
              setCurrSelectedBoxId={setCurrSelectedBoxId}
              isPlaying={isPlaying}
              togglePlayPause={togglePlayPause}
              setCurrTool={setCurrTool}
              theme={theme}
            />
          </div>

          <div className='flex-1 min-h-0 overflow-hidden flex flex-col'>
            <WaveformSpectrogram
              selectedAudio={selectedAudio}
              code={code}
              boxes={boxes}
              setBoxes={setBoxes}
              currSelectedBoxId={currSelectedBoxId}
              setCurrSelectedBoxId={setCurrSelectedBoxId}
              duration={duration}
              setDuration={setDuration}
              setContainerWidth={setContainerWidth}
              setDrawingBox={setDrawingBox}
              visibleTime={visibleTime}
              setVisibleTime={setVisibleTime}
              theme={theme}
              currTool={currTool}
            />
            <Tools
              theme={theme}
              lightMode={lightMode}
            />
          </div>

          {showDataset && (
            <div
              style={{ backgroundColor: theme.panels, height: datasetHeight }}
              className='absolute bottom-0 left-0 right-0 z-[100] rounded-t-xl shadow-2xl overflow-y-auto'
            >
              <div className='h-2 cursor-ns-resize' onMouseDown={handleDragStart} />
              <div className='px-2 pb-2'>
                {showDataset && (
                <DatasetPanel
                  rows={rows}
                  onDeleteRow={(i) => setBoxes(prev => prev.filter((_, idx) => idx !== i))}
                  theme={theme}
                />
                )}
              </div>
            </div>
          )}
        </div>

        {rightPanel !== null && (
          <div style={{ backgroundColor: theme.panels }} className='w-48 shrink-0 rounded-xl p-2 overflow-y-auto'>
            {rightPanel === 2 && (
              <BoxFilePanel
                selectedRow={selectedRow}
                drawingRow={drawingRow}
                selectedAudio={selectedAudio}
                audioFilename={audioFilename}
                theme={theme}
              />
            )}
            {rightPanel === 3 && <SpectrogramPanel theme={theme} />}
          </div>
        )}

      </div>
      )}

    </div>
  );
}

export default App;