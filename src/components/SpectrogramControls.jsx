import { useState, useEffect, useCallback } from 'react';
import { wavesurferRef } from '../utils/wavesurferRef';



function SpectrogramControls({ duration, theme, setDrawingBox }) {
  const [isVPressed, setIsVPressed] = useState(false);
  const [isAPressed, setIsAPressed] = useState(false);
  const [isDPressed, setIsDPressed] = useState(false);
  const [isQPressed, setIsQPressed] = useState(false);
  const [isEPressed, setIsEPressed] = useState(false);
  const [isCPressed, setIsCPressed] = useState(false);
  const [isRPressed, setIsRPressed] = useState(false);
  const [isFPressed, setIsFPressed] = useState(false);
  const [isPlaying, setPlaying] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [speedLimitFlash, setSpeedLimitFlash] = useState(0);
  const [wsZoom, setWsZoom] = useState(0);
  


  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];


  const handlePlayAudio = useCallback(() => {
    wavesurferRef.current?.playPause();
  }, []);

  const getWsScrollContainer = () => {
    const ws = wavesurferRef.current;
    if (!ws) return null;
    return ws.getWrapper()?.parentElement;
  };

  const handleZoomInX = useCallback(() => {
    const ws = wavesurferRef.current;
    if (!ws || !duration) return;
    const newZoom = Math.min(wsZoom + 50, 500);
    ws.zoom(newZoom);
    setWsZoom(newZoom);
  }, [wsZoom, duration]);

  const handleZoomOutX = useCallback(() => {
    const ws = wavesurferRef.current;
    if (!ws || !duration) return;
    const newZoom = Math.max(wsZoom - 50, 0);
    ws.zoom(newZoom);
    setWsZoom(newZoom);
  }, [wsZoom, duration]);


  const handlePanLeft = useCallback(() => {
    const container = getWsScrollContainer();
    if (container) {
      container.scrollLeft -= 100;
    }
  }, []);

  const handlePanRight = useCallback(() => {
    const container = getWsScrollContainer();
    if (container) {
      container.scrollLeft += 100;
    }
  }, []);

  const handleResetView = useCallback(() => {
    const ws = wavesurferRef.current;
    if (!ws) return;
    ws.zoom(0);
    setWsZoom(0);
    setDrawingBox?.(null);
  }, [setDrawingBox]);

  
  const [speed, setSpeed] = useState(1);
  const atSlowestSpeed = speed <= SPEEDS[0];
  const atFastestSpeed = speed >= SPEEDS[SPEEDS.length - 1];

  const handleSpeedChange = (rate) => {
      setSpeed(rate);
      wavesurferRef.current?.setPlaybackRate(rate);
  };

  const triggerSpeedLimitFlash = useCallback(() => {
    setSpeedLimitFlash(n => n + 1);
  }, []);

  const handleCycleSpeedUp = useCallback(() => {
    if (atFastestSpeed) {
      triggerSpeedLimitFlash();
      return;
    }
    const currentIndex = SPEEDS.indexOf(speed);
    const nextIndex = (currentIndex + 1 + SPEEDS.length) % SPEEDS.length;
    handleSpeedChange(SPEEDS[nextIndex]);
    setSpeedOpen(false);
  }, [speed, atFastestSpeed, triggerSpeedLimitFlash]);

  const handleCycleSpeedDown = useCallback(() => {
    if (atSlowestSpeed) {
      triggerSpeedLimitFlash();
      return;
    }
    const currentIndex = SPEEDS.indexOf(speed);
    const nextIndex = (currentIndex - 1 + SPEEDS.length) % SPEEDS.length;
    handleSpeedChange(SPEEDS[nextIndex]);
    setSpeedOpen(false);
  }, [speed, atSlowestSpeed, triggerSpeedLimitFlash]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'v') { setIsVPressed(true); handlePlayAudio(); }
      if (e.key === 'a') { setIsAPressed(true); handlePanLeft(); }
      if (e.key === 'd') { setIsDPressed(true); handlePanRight(); }
      if (e.key === 'q') { setIsQPressed(true); handleZoomInX(); }
      if (e.key === 'e') { setIsEPressed(true); handleZoomOutX(); }
      if (e.key === 'c') { setIsCPressed(true); handleResetView(); }
      if (e.key === 'r') { setIsRPressed(true); handleCycleSpeedUp(); }
      if (e.key === 'f') { setIsFPressed(true); handleCycleSpeedDown(); }
    };
    const handleKeyUp = (e) => {
      if (e.key === 'v') setIsVPressed(false);
      if (e.key === 'a') setIsAPressed(false);
      if (e.key === 'd') setIsDPressed(false);
      if (e.key === 'q') setIsQPressed(false);
      if (e.key === 'e') setIsEPressed(false);
      if (e.key === 'c') setIsCPressed(false);
      if (e.key === 'r') setIsRPressed(false);
      if (e.key === 'f') setIsFPressed(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
    }, [handlePlayAudio, handlePanLeft, handlePanRight, handleZoomInX, handleZoomOutX, handleResetView, handleCycleSpeedUp, handleCycleSpeedDown]);


  useEffect(() => {
    const interval = setInterval(() => {
      const ws = wavesurferRef.current;
      if (!ws) return;
      clearInterval(interval);
      const unsubs = [
        ws.on('play', () => setPlaying(true)),
        ws.on('pause', () => setPlaying(false)),
      ];
      return () => unsubs.forEach(fn => fn());
    }, 50);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className='flex items-center justify-center gap-2 flex-wrap'>
      <div style={{ backgroundColor: theme.group }} className='p-1.5 rounded-xl flex items-center gap-1'>
      <button onClick={handlePlayAudio}
        style={{ backgroundColor: isVPressed ? theme.audioButtonPressed : theme.audioButton, color: theme.audioButtonText }}
        onMouseEnter={(e) => !isVPressed && (e.currentTarget.style.backgroundColor = theme.audioButtonHover)}
        onMouseLeave={(e) => !isVPressed && (e.currentTarget.style.backgroundColor = theme.audioButton)}
        className='px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap cursor-pointer flex items-center gap-1'>
        {isPlaying ? 'Pause Audio' : 'Play Audio'}
        <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>V</div>
      </button>
      </div>

      <div style={{ backgroundColor: theme.group }} className='p-1.5 rounded-xl flex items-center gap-1'>
        <button onClick={handleCycleSpeedDown}
          disabled={atSlowestSpeed}
          style={{ backgroundColor: (isFPressed && !atSlowestSpeed) ? theme.buttonsPressed : theme.buttons, color: theme.buttonsText, opacity: atSlowestSpeed ? 0.4 : 1 }}
          onMouseEnter={(e) => !isFPressed && !atSlowestSpeed && (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          onMouseLeave={(e) => !isFPressed && !atSlowestSpeed && (e.currentTarget.style.backgroundColor = theme.buttons)}
          className={`px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap flex items-center gap-1 ${atSlowestSpeed ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
          Slower
          <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>F</div>
        </button>

        <div className='relative'>
          <button
            key={speedLimitFlash}
            onClick={() => setSpeedOpen(prev => !prev)}
            style={{ backgroundColor: theme.buttons, color: theme.buttonsText }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = theme.buttons)}
            className={`px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap cursor-pointer ${speedLimitFlash > 0 ? 'speed-limit-flash' : ''}`}>
            {speed}x
          </button>
          {speedOpen && (
            <div
              style={{ backgroundColor: theme.group }}
              className='absolute top-full mt-1 left-0 rounded-md overflow-hidden z-50 flex flex-col min-w-[80px]'>
              <input
                type='number'
                defaultValue={speed}
                min={0.1}
                max={4}
                step={0.05}
                onBlur={(e) => { const v = Number(e.target.value); if (v > 0) handleSpeedChange(v); }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') { handleSpeedChange(Number(e.target.value)); setSpeedOpen(false); }
                }}
                style={{ backgroundColor: theme.textInput, color: theme.textInputText }}
                className='px-2 py-1.5 text-xs font-display outline-none w-full'
                autoFocus
              />
            </div>
          )}
        </div>

        <button onClick={handleCycleSpeedUp}
          disabled={atFastestSpeed}
          style={{ backgroundColor: (isRPressed && !atFastestSpeed) ? theme.buttonsPressed : theme.buttons, color: theme.buttonsText, opacity: atFastestSpeed ? 0.4 : 1 }}
          onMouseEnter={(e) => !isRPressed && !atFastestSpeed && (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          onMouseLeave={(e) => !isRPressed && !atFastestSpeed && (e.currentTarget.style.backgroundColor = theme.buttons)}
          className={`px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap flex items-center gap-1 ${atFastestSpeed ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
          Faster
          <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>R</div>
        </button>
      </div>

      <div style={{ backgroundColor: theme.group }} className='p-1.5 rounded-xl flex items-center gap-1'>
        <button onClick={handlePanLeft}
          style={{ backgroundColor: isAPressed ? theme.buttonsPressed : theme.buttons, color: theme.buttonsText }}
          onMouseEnter={(e) => !isAPressed && (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          onMouseLeave={(e) => !isAPressed && (e.currentTarget.style.backgroundColor = theme.buttons)}
          className='px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap cursor-pointer flex items-center gap-1'>
          Pan Left
          <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>A</div>
        </button>
        <button onClick={handlePanRight}
          style={{ backgroundColor: isDPressed ? theme.buttonsPressed : theme.buttons, color: theme.buttonsText }}
          onMouseEnter={(e) => !isDPressed && (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          onMouseLeave={(e) => !isDPressed && (e.currentTarget.style.backgroundColor = theme.buttons)}
          className='px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap cursor-pointer flex items-center gap-1'>
          Pan Right
          <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>D</div>
        </button>
      </div>

      <div style={{ backgroundColor: theme.group }} className='p-1.5 rounded-xl flex items-center gap-1'>
        <button onClick={handleZoomInX}
          style={{ backgroundColor: isQPressed ? theme.buttonsPressed : theme.buttons, color: theme.buttonsText }}
          onMouseEnter={(e) => !isQPressed && (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          onMouseLeave={(e) => !isQPressed && (e.currentTarget.style.backgroundColor = theme.buttons)}
          className='px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap cursor-pointer flex items-center gap-1'>
          Zoom In (X)
          <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>Q</div>
        </button>
        <button onClick={handleZoomOutX}
          style={{ backgroundColor: isEPressed ? theme.buttonsPressed : theme.buttons, color: theme.buttonsText }}
          onMouseEnter={(e) => !isEPressed && (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          onMouseLeave={(e) => !isEPressed && (e.currentTarget.style.backgroundColor = theme.buttons)}
          className='px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap cursor-pointer flex items-center gap-1'>
          Zoom Out (X)
          <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>E</div>
        </button>


        <button onClick={handleResetView}
          style={{ backgroundColor: isCPressed ? theme.buttonsPressed : theme.buttons, color: theme.buttonsText }}
          onMouseEnter={(e) => !isCPressed && (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          onMouseLeave={(e) => !isCPressed && (e.currentTarget.style.backgroundColor = theme.buttons)}
          className='px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap cursor-pointer flex items-center gap-1'>
          Reset View
          <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>C</div>
        </button>
      </div>
    </div>
  );
}

export default SpectrogramControls;