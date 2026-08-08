import { getSessionConfig, DEFAULT_LS_URL } from '../utils/sessionConfig';

function getLsConfig() {
  const config = getSessionConfig();
  return {
    lsUrl: config?.lsUrl || DEFAULT_LS_URL,
    token: config?.token || '',
    projectId: config?.projectId || import.meta.env.VITE_LS_PROJECT_ID || '',
  };
}

function authHeaders() {
  const { token } = getLsConfig();
  return { Authorization: `Token ${token}` };
}

/** Turn a task data audio path into a fetchable URL (matches original App.jsx). */
export function resolveTaskAudioUrl(audioPath) {
  const { lsUrl } = getLsConfig();
  if (!audioPath || typeof audioPath !== 'string') return null;
  if (audioPath.startsWith('http') || audioPath.startsWith('blob:')) return audioPath;
  // Vite demo assets (/src/assets, /assets) are served from the app origin
  if (!audioPath.startsWith('/data/')) return audioPath;
  return `${lsUrl}${audioPath}`;
}

function fetchHeadersForUrl(url) {
  const { lsUrl } = getLsConfig();
  return url.startsWith(lsUrl) ? authHeaders() : undefined;
}

export async function fetchAuthenticatedAudio(url) {
  const response = await fetch(url, { headers: fetchHeadersForUrl(url) });
  if (!response.ok) throw new Error(`Failed to fetch audio: ${response.status}`);
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export async function fetchAuthenticatedAudioBuffer(url) {
  const response = await fetch(url, { headers: fetchHeadersForUrl(url) });
  if (!response.ok) throw new Error(`Failed to fetch audio: ${response.status}`);
  return response.arrayBuffer();
}

// Get next unlabeled task (next audio file to annotate)
export const getNextTask = () => {
  const { lsUrl, projectId } = getLsConfig();
  const BASE = `${lsUrl}/api`;
  return fetch(`${BASE}/projects/${projectId}/next/`, {
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
  }).then((r) => r.json());
};

// Submit your boxes as an annotation
export const submitAnnotation = (taskId, boxes) => {
  const { lsUrl } = getLsConfig();
  const BASE = `${lsUrl}/api`;
  return fetch(`${BASE}/tasks/${taskId}/annotations/`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      result: boxes.map((box) => ({
        type: 'rectanglelabels',
        value: {
          start: box.startTime,
          end: box.endTime,
          startFreq: box.startFreq,
          endFreq: box.endFreq,
          labels: [box.code],
        },
      })),
    }),
  }).then((r) => r.json());
};
