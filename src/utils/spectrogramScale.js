import { SPECTROGRAM_HEIGHT } from './spectrogramConfig';

// Match wavesurfer.js/src/plugins/spectrogram.ts
const ERB_A = (1000 * Math.log(10)) / (24.7 * 4.37);

const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel) => 700 * (Math.pow(10, mel / 2595) - 1);

const hzToLog = (hz) => Math.log10(Math.max(1, hz));
const logToHz = (log) => Math.pow(10, log);

const hzToBark = (hz) => {
  let bark = (26.81 * hz) / (1960 + hz) - 0.53;
  if (bark < 2) bark += 0.15 * (2 - bark);
  if (bark > 20.1) bark += 0.22 * (bark - 20.1);
  return bark;
};

const barkToHz = (bark) => {
  if (bark < 2) bark = (bark - 0.3) / 0.85;
  if (bark > 20.1) bark = (bark + 4.422) / 1.22;
  return 1960 * ((bark + 0.53) / (26.28 - bark));
};

const hzToErb = (hz) => ERB_A * Math.log10(1 + hz * 0.00437);
const erbToHz = (erb) => (Math.pow(10, erb / ERB_A) - 1) / 0.00437;

function hzToScale(hz, scale) {
  switch (scale) {
    case 'mel':
      return hzToMel(hz);
    case 'logarithmic':
    case 'log':
      return hzToLog(hz);
    case 'bark':
      return hzToBark(hz);
    case 'erb':
      return hzToErb(hz);
    default:
      return hz;
  }
}

function scaleToHz(scaleVal, scale) {
  switch (scale) {
    case 'mel':
      return melToHz(scaleVal);
    case 'logarithmic':
    case 'log':
      return logToHz(scaleVal);
    case 'bark':
      return barkToHz(scaleVal);
    case 'erb':
      return erbToHz(scaleVal);
    default:
      return scaleVal;
  }
}

export function freqToY(hz, freqMin, freqMax, scale = 'mel') {
  const scaleMin = hzToScale(freqMin, scale);
  const scaleMax = hzToScale(freqMax, scale);
  const range = scaleMax - scaleMin;
  const fraction = range === 0 ? 0 : 1 - (hzToScale(hz, scale) - scaleMin) / range;
  return fraction * SPECTROGRAM_HEIGHT;
}

export function yToFreq(y, freqMin, freqMax, scale = 'mel') {
  const fraction = 1 - y / SPECTROGRAM_HEIGHT;
  const scaleMin = hzToScale(freqMin, scale);
  const scaleMax = hzToScale(freqMax, scale);
  const hz = scaleToHz(scaleMin + fraction * (scaleMax - scaleMin), scale);
  return Math.max(freqMin, Math.min(freqMax, hz));
}
