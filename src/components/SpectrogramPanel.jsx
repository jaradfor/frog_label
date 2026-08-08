import { useState, useEffect } from 'react';
import { usePanels } from '../hooks/usePanels';
import generateViridis from '../color_palettes/viridis.jsx'
import generateMagma from '../color_palettes/magma.jsx';
import generateInferno from '../color_palettes/inferno.jsx'
import generatePlasma from '../color_palettes/plasma.jsx'

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function SliderWithInput({
    label,
    value,
    min,
    max,
    step,
    unit = '',
    decimals = 0,
    onChange,
    theme,
}) {
    const [draft, setDraft] = useState('');
    const [focused, setFocused] = useState(false);

    const format = (v) => (decimals === 0 ? String(Math.round(v)) : Number(v).toFixed(decimals));

    // Re-sync the text draft from the external value whenever it changes elsewhere
    // (e.g. another control moves the same setting), but only while this input
    // isn't focused, so we never clobber text the user is actively typing.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (!focused) setDraft(format(value));
    }, [value, focused, decimals]);

    const commit = (raw) => {
        const trimmed = raw.trim();
        if (trimmed === '' || trimmed === '-' || trimmed === '.') {
            setDraft(format(value));
            return;
        }
        const parsed = decimals === 0 ? parseInt(trimmed, 10) : parseFloat(trimmed);
        if (Number.isNaN(parsed)) {
            setDraft(format(value));
            return;
        }
        const clamped = clamp(parsed, min, max);
        const final = decimals === 0 ? clamped : parseFloat(clamped.toFixed(decimals));
        onChange(final);
        setDraft(format(final));
    };

    return (
        <div className='flex flex-col gap-1'>
            <div className='flex justify-between items-center gap-2'>
                <span className='font-display text-sm' style={{ color: theme.text }}>{label}</span>
                <div className='flex items-center gap-1'>
                    <input
                        type='text'
                        inputMode={decimals === 0 ? 'numeric' : 'decimal'}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onFocus={() => setFocused(true)}
                        onBlur={() => {
                            setFocused(false);
                            commit(draft);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur();
                        }}
                        className='w-[4.5rem] min-h-[28px] px-2 py-1.5 text-sm rounded-md font-display text-right outline-none border-2 border-transparent focus:border-blue-400 ring-1 ring-transparent focus:ring-white focus:ring-offset-0'
                        style={{ backgroundColor: theme.textInput, color: theme.textInputText }}
                    />
                    {unit && (
                        <span className='font-display text-xs' style={{ color: theme.text }}>{unit}</span>
                    )}
                </div>
            </div>
            <input
                type='range'
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(decimals === 0 ? Number(e.target.value) : parseFloat(e.target.value))}
                className='w-full cursor-pointer'
                style={{ accentColor: theme.buttonsPressed }}
            />
        </div>
    );
}

function SpectrogramPanel({ theme }) {
    const { brightness, setBrightness } = usePanels();
    const { contrast, setContrast } = usePanels();
    const { colorScale, setColorScale } = usePanels();
    const { FFTSamples, setFFTSamples } = usePanels();
    const { yScale, setYScale } = usePanels();
    const { windowFunction, setWindowFunction } = usePanels();
    const { overlap, setOverlap } = usePanels();
    const { maxFreq } = usePanels();
    const { setModifyBandPass } = usePanels();
    const { lowCutoff, setLowCutoff } = usePanels();
    const { highCutoff, setHighCutoff } = usePanels();
    const [pendingLow, setPendingLow] = useState(lowCutoff);
    const [pendingHigh, setPendingHigh] = useState(highCutoff);

    // Keep the pending (unapplied) slider values in sync when the applied
    // cutoff changes elsewhere (e.g. "Reset" or a newly loaded audio file).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { setPendingLow(lowCutoff); }, [lowCutoff]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { setPendingHigh(highCutoff); }, [highCutoff]);



    const colorScales = [
        { name: 'roseus', gradient: 'linear-gradient(to right, #dbc642, #f36e1c, #d94f8a, #7a1b6c, #2b0a3d )', dbfs: [-120, -90, -60, -30, 0], colorMap: 'roseus' },
        { name: 'inferno', gradient: 'linear-gradient(to right, #000004, #420a68, #932667, #dd513a, #fca50a, #fcffa4)', dbfs: [-120, -90, -60, -30, 0], colorMap: generateInferno() },
        { name: 'igray', gradient: 'linear-gradient(to right, #ffffff, #000000 ', dbfs: [-120, -90, -60, -30, 0],  colorMap:'igray' },
        { name: 'gray', gradient: 'linear-gradient(to right, #000000, #ffffff)', dbfs: [-120, -90, -60, -30, 0],  colorMap: 'gray' },
        { name: 'viridis', gradient: 'linear-gradient(to right, #440154, #30678d, #35b778, #fde724)', dbfs: [-120, -90, -60, -30, 0], colorMap: generateViridis()},
        { name: 'magma', gradient: 'linear-gradient(to right, #000004, #51127c, #b73779, #fc8961, #fbfdbf)', dbfs: [-120, -90, -60, -30, 0], colorMap: generateMagma()},
        { name: 'plasma', gradient: 'linear-gradient(to right, #0d0887, #6a00a8, #b12a90, #e16462, #fca636, #f0f921)', dbfs: [-120, -90, -60, -30, 0], colorMap: generatePlasma() },
    ]

    const colorName = colorScales.find(c => c.name === colorScale) || colorScales[0];
    const titleClass = 'font-display text-md';
    const labelClass = 'font-display text-sm';
    const metaClass = 'font-display text-xs';
    const overlapValue = Number(overlap) || 0;

    const handleBandPassFilter = () => {
        const low = Math.min(pendingLow, pendingHigh);
        const high = Math.max(pendingLow, pendingHigh);
        setPendingLow(low);
        setPendingHigh(high);
        setLowCutoff(low);
        setHighCutoff(high);
        setModifyBandPass(true);
    };

    const handleRemoveBandPassFilter = () => {
        setLowCutoff(0);
        setHighCutoff(maxFreq);
        setModifyBandPass(true);
    };

    const buttonProps = (active) => ({
        style: {
            backgroundColor: active ? theme.buttonsPressed : theme.buttons,
            color: theme.buttonsText,
        },
        onMouseEnter: (e) => !active && (e.currentTarget.style.backgroundColor = theme.buttonsHover),
        onMouseLeave: (e) => !active && (e.currentTarget.style.backgroundColor = theme.buttons),
    });

    return (
        <div className='flex flex-col gap-2'>
            <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-sm font-display px-2 rounded-md w-5 flex items-center justify-center'>3</div>
            <div style={{ backgroundColor: theme.group, color: theme.text }} className='flex flex-col flex-1 rounded-lg p-2 gap-1'>
                <span className={titleClass} style={{ color: theme.text }}>FFT Window Size</span>
                <div className='flex gap-1'>
                    {[512, 1024, 2048, 4096].map((size) => (
                        <button
                            key={size}
                            onClick={() => setFFTSamples(size)}
                            {...buttonProps(FFTSamples === size)}
                            className={`flex-1 py-1.5 ${labelClass} rounded-sm cursor-pointer`}>
                            {size}
                        </button>
                    ))}
                </div>
            </div>

            <div style={{ backgroundColor: theme.group, color: theme.text }} className='flex flex-col flex-1 rounded-lg p-2 gap-1'>
                <span className={titleClass} style={{ color: theme.text }}>Frequency Axis Scale</span>
                <div className='flex flex-col gap-1'>
                    {[
                        ['mel', 'Mel'],
                        ['linear', 'Linear'],
                        ['logarithmic', 'Logarithmic'],
                        ['bark', 'Bark'],
                        ['erb', 'ERB'],
                    ].map(([scale, label]) => (
                        <button
                            key={scale}
                            onClick={() => setYScale(scale)}
                            {...buttonProps(yScale === scale)}
                            className={`px-2 py-2 ${labelClass} rounded-sm cursor-pointer text-left`}>
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            <div style={{ backgroundColor: theme.group, color: theme.text }} className='flex flex-col flex-1 rounded-lg p-2 gap-1'>
                <span className={titleClass} style={{ color: theme.text }}>Analysis Window</span>
                <div className='flex flex-col gap-1'>
                    {['hann', 'hamming', 'blackman', 'bartlett', 'cosine', 'gauss', 'lanczoz', 'rectangular', 'triangular'].map((name) => (
                        <button
                            key={name}
                            onClick={() => setWindowFunction(name)}
                            {...buttonProps(windowFunction === name)}
                            className={`px-2 py-2 ${labelClass} rounded-sm cursor-pointer text-left capitalize`}>
                            {name}
                        </button>
                    ))}
                </div>
            </div>

            <div style={{ backgroundColor: theme.group, color: theme.text }} className='flex flex-col flex-1 rounded-lg p-2 gap-3'>
                <span className={titleClass} style={{ color: theme.text }}>Frame Overlap</span>
                <SliderWithInput
                    label='Overlap'
                    value={overlapValue}
                    min={0}
                    max={100}
                    step={1}
                    unit='%'
                    decimals={0}
                    onChange={setOverlap}
                    theme={theme}
                />
            </div>

            <div style={{ backgroundColor: theme.group, color: theme.text }} className='flex flex-col flex-1 rounded-lg p-2 gap-3'>
                <span className={titleClass} style={{ color: theme.text }}>Display Tuning</span>
                <SliderWithInput
                    label='Brightness'
                    value={brightness}
                    min={0}
                    max={5}
                    step={0.01}
                    decimals={2}
                    onChange={setBrightness}
                    theme={theme}
                />
                <SliderWithInput
                    label='Contrast'
                    value={contrast}
                    min={0}
                    max={5}
                    step={0.01}
                    decimals={2}
                    onChange={setContrast}
                    theme={theme}
                />
                <button
                    onClick={() => { setBrightness(1); setContrast(1); }}
                    style={{ backgroundColor: theme.buttons, color: theme.buttonsText }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = theme.buttons)}
                    className='rounded-md py-1 mt-1 cursor-pointer'>
                    <span className={labelClass}>Reset</span>
                </button>
            </div>

            <div style={{ backgroundColor: theme.group, color: theme.text }} className='flex flex-col flex-1 rounded-lg p-2 gap-3'>
                <span className={titleClass} style={{ color: theme.text }}>Visible Frequency Range</span>
                <SliderWithInput
                    label='Minimum frequency'
                    value={pendingLow}
                    min={0}
                    max={maxFreq}
                    step={50}
                    unit='Hz'
                    decimals={0}
                    onChange={setPendingLow}
                    theme={theme}
                />
                <SliderWithInput
                    label='Maximum frequency'
                    value={pendingHigh}
                    min={0}
                    max={maxFreq}
                    step={50}
                    unit='Hz'
                    decimals={0}
                    onChange={setPendingHigh}
                    theme={theme}
                />
                <div className='flex gap-2 mt-1'>
                    <button
                        onClick={handleBandPassFilter}
                        style={{ backgroundColor: theme.buttons, color: theme.buttonsText }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = theme.buttons)}
                        className='flex-1 rounded-md py-1 cursor-pointer'>
                        <span className={labelClass}>Apply</span>
                    </button>
                    <button
                        onClick={handleRemoveBandPassFilter}
                        style={{ backgroundColor: theme.buttons, color: theme.buttonsText }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = theme.buttons)}
                        className='flex-1 rounded-md py-1 cursor-pointer'>
                        <span className={labelClass}>Reset</span>
                    </button>
                </div>
            </div>

            <div style={{ backgroundColor: theme.group, color: theme.text }} className='flex flex-col flex-1 rounded-lg p-2 gap-1'>
                <span className={titleClass} style={{ color: theme.text }}>Colormap & Level Scale</span>
                <div className='flex flex-col gap-2'>
                    <div className='flex flex-col gap-1'>
                        <span className={labelClass} style={{ color: theme.text }}>Palette</span>
                        {colorScales.map(({ name, gradient }) => (
                            <div
                                key={name}
                                onClick={() => setColorScale(name)}
                                className='flex flex-row items-center gap-2 cursor-pointer'>
                                <div style={{ borderColor: theme.keyButtons }} className='w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0'>
                                    {colorScale === name && (
                                        <div style={{ backgroundColor: theme.keyButtons }} className='w-2 h-2 rounded-full' />
                                    )}
                                </div>
                                <div className='h-4 rounded-sm flex-1 capitalize' style={{ background: gradient }} />
                                <span className={`${metaClass} capitalize`} style={{ color: theme.text }}>{name}</span>
                            </div>
                        ))}
                    </div>

                    <div className='flex flex-col gap-0.5'>
                        <span className={labelClass} style={{ color: theme.text }}>Level scale (dBFS)</span>
                        <div className='h-4 rounded-sm w-full' style={{ background: colorName.gradient }} />
                        <div className='flex flex-row justify-between'>
                            {colorName.dbfs.map(val => (
                                <span key={val} className={metaClass} style={{ color: theme.text }}>{val}</span>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default SpectrogramPanel;
