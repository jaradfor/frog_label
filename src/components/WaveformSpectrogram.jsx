import BoundingBoxLayer from "./BoundingBoxLayer";
import { useEffect, useState, useRef, useMemo } from "react";
import Spectrogram from "wavesurfer.js/dist/plugins/spectrogram.esm.js";
import WaveSurfer from "wavesurfer.js";
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import { WAVEFORM_HEIGHT, SCALE, SPECTROGRAM_HEIGHT, FREQUENCY_MIN, FREQUENCY_MAX, FFT_SAMPLES } from "../utils/spectrogramConfig";
import { freqToY, yToFreq } from '../utils/spectrogramScale';
import { fetchAuthenticatedAudio } from '../api/labelStudio';
import { getAudioInfo } from '../utils/audioInfo';
import { usePanels } from './PanelContext';
import moonCursor from '../assets/moon_cursor.png';

import generateViridis from '../color_palettes/viridis.jsx'
import generateMagma from '../color_palettes/magma.jsx'
import generateInferno from "../color_palettes/inferno.jsx";
import generatePlasma from '../color_palettes/plasma.jsx'


export const wavesurferRef = { current: null };

function WaveformSpectrogram({
    selectedAudio,
    code,
    boxes,
    setBoxes,
    currSelectedBoxId,
    setCurrSelectedBoxId,
    duration,
    setDuration,
    setDrawingBox,
    visibleTime,
    setVisibleTime,
    theme,
    currTool
}) {
    const [localSampleRate, setLocalSampleRate] = useState(null);
    const [spectroReady, setSpectroReady] = useState(false);
    const containerRef = useRef(null);
    const [spectroTop] = useState(WAVEFORM_HEIGHT);
    const [spectroHeight] = useState(SPECTROGRAM_HEIGHT);
    const [viewWidth, setViewWidth] = useState(0);

    const { brightness, contrast}= usePanels();
    const {handleSpectroMouseDown, handleSpectroMouseMove, handleSpectroMouseUp} = usePanels();
    const { colorScale } = usePanels();
    const { yScale } = usePanels();
    const { FFTSamples } = usePanels();
    const { windowFunction } = usePanels();
    const { overlap } = usePanels();
    const { modifyBandPass, setModifyBandPass } = usePanels();
    const { lowCutoff, highCutoff, setHighCutoff} = usePanels();
    const { maxFreq, setMaxFreq} = usePanels();
    const { sampleRate, setSampleRate} = usePanels();
    const viridisMap = generateViridis();
    const magmaMap = generateMagma();
    const infernoMap = generateInferno();
    const plasmaMap = generatePlasma();

    const COLOR_MAPS = {
    roseus: 'roseus',
    igray: 'igray',
    gray: 'gray',
    viridis: viridisMap,
    magma: magmaMap,
    inferno: infernoMap,
    plasma: plasmaMap,
    };
    


    const generateFreqLabels = (minFreq, maxFreq, numLabels = 10) => {
        return Array.from({ length: numLabels }, (_, i) => {
            // evenly spaced Y positions from bottom (0) to top (spectroHeight)
            const y = (i / (numLabels - 1)) * spectroHeight;
            return Math.round(yToFreq(y, minFreq, maxFreq, yScale));
        });
    };

    const FREQ_LABELS = useMemo(
        () => generateFreqLabels(lowCutoff, highCutoff),
        [lowCutoff, highCutoff, yScale, spectroHeight]
    );

    useEffect(() => {
        if (!containerRef.current || !selectedAudio) return;

        const ro = new ResizeObserver(([entry]) => {
            setViewWidth(entry.contentRect.width);
        });
        ro.observe(containerRef.current);

        let cancelled = false;
        let ws = null;
        let blobUrl = null;
        setSpectroReady(false);

        getAudioInfo(selectedAudio).then(({ sampleRate, maxFrequency }) => {
            if (cancelled) return;
            setLocalSampleRate(sampleRate);
            setSampleRate(sampleRate);
            setMaxFreq(maxFrequency);
            if (highCutoff==0) setHighCutoff(maxFrequency);

            const spectroPlugin = Spectrogram.create({
                            labels: false,
                            height: SPECTROGRAM_HEIGHT,
                            splitChannels: false,
                            scale: yScale,
                            frequencyMax: highCutoff,
                            frequencyMin: lowCutoff,
                            fftSamples: FFTSamples,
                            labelsBackground: 'rgba(0, 0, 0, 0.1)',
                            useWebWorker: true,
                            colorMap: COLOR_MAPS[colorScale] ?? 'gray',
                            noverlap : overlap,
                            windowFunc: windowFunction,
            })

            fetchAuthenticatedAudio(selectedAudio).then((url) => {
              blobUrl = url;
              if (!blobUrl || cancelled) return;
              
              ws = WaveSurfer.create({
                  container: containerRef.current,
                  height: WAVEFORM_HEIGHT,
                  barHeight: 3,
                  url: blobUrl,
                  //minPxPerSec: 0,
                  fillParent: true,
                  autoCenter: false,
                  hideScrollbar: true,
                  waveColor: theme.waveform,
                  cursorColor: theme.cursor,
                  progressColor: theme.progress,
                  cursorWidth: 3,
                  sampleRate: sampleRate,
                  dragToSeek: true,
                  plugins: [
                     spectroPlugin,
                      TimelinePlugin.create({
                          style: { fontSize: '12px', color: theme.text, fontFamily: 'Afacad, sans-serif' },
                          formatTimeCallback: (seconds) => `${seconds.toFixed(1)} s`,
                      }),
                  ],
              });
               setModifyBandPass(false);

              ws.on('ready', () => {
                  const totalDur = ws.getDuration();
                  setDuration(totalDur);
                  setVisibleTime({ start: 0, end: totalDur });
                  setSpectroReady(true);
              });

              // Keep visibleTime in sync with wavesurfer's actual scroll position/width
              // instead of computing it from a locally-tracked zoom value, so playback
              // auto-scroll, drag-to-seek, and any container resize (browser zoom, OS
              // window snap, sidebar toggles) all stay reflected accurately.
              const syncVisibleTime = () => {
                  const wrapper = ws.getWrapper()?.parentElement;
                  if (!wrapper) return;
                  const { scrollLeft, scrollWidth, clientWidth } = wrapper;
                  const dur = ws.getDuration();
                  if (!scrollWidth || !dur) return;
                  setVisibleTime({
                      start: (scrollLeft / scrollWidth) * dur,
                      end: Math.min(dur, ((scrollLeft + clientWidth) / scrollWidth) * dur),
                  });
              };

              ws.on('scroll', (start, end) => setVisibleTime({ start, end }));
              ws.on('zoom', syncVisibleTime);
              ws.on('resize', syncVisibleTime);

              wavesurferRef.current = ws;
            }).catch((error) => {
              console.error('Error fetching audio:', error);
            });
        }).catch((error) => {
            console.error('Error reading audio info:', error);
        });

        return () => {
            cancelled = true;
            ro.disconnect();
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            if (wavesurferRef.current) {
                wavesurferRef.current.destroy();
            }
            wavesurferRef.current = null;
            setSpectroReady(false);
        };
    }, [setDuration, selectedAudio, colorScale, FFTSamples, modifyBandPass, windowFunction, overlap, yScale, lowCutoff, highCutoff]);

    const cursorMap = (tool) => {
        if (tool === 1) return 'auto';
        if (tool === 2) return 'crosshair';
        if (tool === 3) return `url(${moonCursor}), auto`;
        return 'auto';
    };
    
    return (
        <div style={{ backgroundColor: theme.panels }} className="flex-1 min-h-0 p-6 pb-2 rounded-xl my-2 overflow-auto">
            <div className="flex">

                {/* Frequency Labels */}
                <div
                    className="relative shrink-0 w-11 items-end pr-1"
                    style={{ marginTop: spectroTop, height: spectroHeight }}
                >
                    {localSampleRate && lowCutoff != null && highCutoff != null && highCutoff > 0
                        ? FREQ_LABELS.map((freq) => (
                            <span
                                key={freq}
                                className="absolute right-1 text-right text-[12px] font-display leading-none"
                                style={{
                                    top: Math.min(freqToY(freq, lowCutoff, highCutoff, yScale), spectroHeight - 1),
                                    transform: 'translateY(-50%)',
                                    color: theme.text,
                                }}
                            >
                                {freq} Hz
                            </span>
                        ))
                        : <span className="absolute right-1 text-[12px] font-display" style={{ color: theme.text }}>0 Hz</span>
                    }
                </div>

                {/* Waveform + Spectrogram + Bounding Box Overlay */}
                <div className="relative w-full overflow-hidden">
                    <div ref={containerRef} className="relative z-10" />
                    {/* mouse events for contrast/brightness  */}
                    <div
                      className="absolute z-50 left-0 right-0"
                      style={{ 
                        top: spectroTop, 
                        height: spectroHeight, 
                        pointerEvents: currTool === 1 ? 'none' : 'auto',
                        cursor: 'inherit'
                    }}
                      onMouseDown={currTool === 1 ? undefined : handleSpectroMouseDown}
                      onMouseMove={currTool === 1 ? undefined : handleSpectroMouseMove}
                      onMouseUp={currTool === 1 ? undefined : handleSpectroMouseUp}
                      onMouseLeave={currTool === 1 ? undefined : handleSpectroMouseUp}
                    >
                        {/* Brightness / Contrast filter */}
                        <div
                            className="absolute left-0 right-0 pointer-events-none"
                            style={{
                                top: 0,
                                height: spectroHeight,
                                backdropFilter: `brightness(${brightness}) contrast(${contrast})`,
                                zIndex: 10,
                            }}
                        />

                        <div className="w-full h-full relative" style={{ pointerEvents: currTool === 1 ? 'none' : 'auto', cursor: cursorMap(currTool) }}>
                            {spectroReady && (
                                <BoundingBoxLayer
                                    code={code}
                                    boxes={boxes}
                                    setBoxes={setBoxes}
                                    currSelectedBoxId={currSelectedBoxId}
                                    setCurrSelectedBoxId={setCurrSelectedBoxId}
                                    setDrawingBox={setDrawingBox}
                                    canvasWidth={viewWidth}
                                    visibleTime={visibleTime}
                                    theme={theme}
                                    currTool={currTool}
                                    lowCutoff={lowCutoff}
                                    highCutoff={highCutoff}
                                    yScale={yScale}
                                />
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default WaveformSpectrogram;