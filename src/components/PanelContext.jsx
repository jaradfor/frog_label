import { useState, useRef } from 'react';
import { SCALE, FREQUENCY_MIN, FREQUENCY_MAX, FFT_SAMPLES } from "../utils/spectrogramConfig";
import { PanelContext } from '../hooks/usePanels';

//all variables that need to be accessed by multiple files will be created and saved here to be accessed.
export function PanelProvider({ children }) {
  const [currTool,      setCurrTool] = useState(1);
  const [showLeftPanel, setShowLeftPanel] = useState(false);
  const [rightPanel,    setRightPanel] = useState(null);
  const [showDataset,   setShowDataset] = useState(false);
  const [brightness,    setBrightness] = useState(1.0);
  const [contrast,      setContrast] = useState(1.0);
  const [yScale,        setYScale] = useState(SCALE);
  const [colorScale,    setColorScale] = useState('roseus');
  const [FFTSamples,    setFFTSamples] = useState(FFT_SAMPLES);
  const [windowFunction,setWindowFunction ] = useState('hann');
  const [overlap,       setOverlap ] = useState(0);
  const [minFreq,       setMinFreq] = useState(FREQUENCY_MIN);
  const [maxFreq,       setMaxFreq] = useState(FREQUENCY_MAX);
  const [modifyBandPass,setModifyBandPass] = useState(false);
  const [lowCutoff,     setLowCutoff] = useState(1);
  const [highCutoff,    setHighCutoff] = useState(0); 
  const [sampleRate,    setSampleRate] = useState(null);


  const isDragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const handleSpectroMouseDown = (e) => {
    if (rightPanel != 3 || currTool == 2) return;
    isDragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    e.stopPropagation();
   };

  const handleSpectroMouseMove = (e) => {
    if (!isDragging.current || currTool == 2) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setBrightness(prev => Math.max(0.0, Math.min(5.0, prev + dx * 0.01)));
    setContrast(prev =>   Math.max(0.0, Math.min(5.0, prev - dy * 0.01)));
  };

  const handleSpectroMouseUp = () => { isDragging.current = false; };
  

  return (
    <PanelContext.Provider value={{
      currTool,      setCurrTool,
      showLeftPanel, setShowLeftPanel,
      rightPanel,    setRightPanel,
      showDataset,   setShowDataset,
      brightness,    setBrightness,
      contrast,      setContrast,
      yScale,        setYScale,
      colorScale,    setColorScale,
      FFTSamples,    setFFTSamples,
      windowFunction,setWindowFunction,
      overlap,       setOverlap,
      minFreq,       setMinFreq,
      maxFreq,       setMaxFreq,
      lowCutoff,     setLowCutoff,
      highCutoff,    setHighCutoff,
      modifyBandPass,setModifyBandPass,
      sampleRate,    setSampleRate,
      handleSpectroMouseDown,
      handleSpectroMouseMove,
      handleSpectroMouseUp,
    }}>
      {children}
    </PanelContext.Provider>
  );
}