import { boxesToLsResults } from '../serializers/labelStudioCeResults';
import { getSessionConfig, DEFAULT_LS_URL } from '../utils/sessionConfig';

function apiConfig() {
  const config = getSessionConfig();
  const lsUrl = config?.lsUrl || DEFAULT_LS_URL;
  const token = config?.token || '';
  const projectId = config?.projectId || import.meta.env.VITE_LS_PROJECT_ID || '';

  return {
    base: `${lsUrl}/api`,
    projectId,
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json',
    },
  };
}

export const labelStudioCeAdapter = {
  async getNextTask() {
    const { base, projectId, headers } = apiConfig();
    const url = `${base}/projects/${projectId}/next/`;
    console.log('Fetching next task from:', url);
    const response = await fetch(url, { headers });
    console.log('Response status:', response.status);

    if (response.status === 404 || response.status === 204) {
      console.log('No more tasks (status:', response.status + ')');
      return null;
    }
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Task fetch failed:', response.status, errorText);
      throw new Error(`Failed to fetch next task: ${response.status} - ${errorText}`);
    }
    const task = await response.json();
    console.log('Task loaded:', task);
    return task;
  },

  submitAnnotation(taskId, boxes) {
    const { base, headers } = apiConfig();
    return fetch(`${base}/tasks/${taskId}/annotations/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ result: boxesToLsResults(boxes) }),
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to submit annotation: ${response.status}`);
      }
      return response.json();
    });
  },

  updateAnnotation(annotationId, boxes) {
    const { base, headers } = apiConfig();
    return fetch(`${base}/annotations/${annotationId}/`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ result: boxesToLsResults(boxes) }),
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to update annotation: ${response.status}`);
      }
      return response.json();
    });
  },
};
