import greenAudio from '../assets/green_tree.mp3';
import peronsAudio from '../assets/perons_tree.mp3';
import redEyedAudio from '../assets/red_eyed_tree.mp3';
import frquencyTestAudio from '../assets/audioFrequencyTestingSounds.mp3';

const DEMO_TASKS = [
  { id: 'demo-green', data: { audio: greenAudio }, annotations: [] },
  { id: 'demo-perons', data: { audio: peronsAudio }, annotations: [] },
  { id: 'demo-red-eyed', data: { audio: redEyedAudio }, annotations: [] },
  { id: 'demo-different-frequency-tests', data: { audio: frquencyTestAudio }, annotations: [] },
];

let taskIndex = 0;

export const demoAdapter = {
  getNextTask() {
    if (taskIndex >= DEMO_TASKS.length) {
      return Promise.resolve(null);
    }
    const task = DEMO_TASKS[taskIndex];
    taskIndex += 1;
    return Promise.resolve({ ...task });
  },
  submitAnnotation(_taskId, _boxes) {
    return Promise.resolve({ ok: true });
  },
  updateAnnotation(_annotationId, _boxes) {
    return Promise.resolve({ ok: true });
  },
};
