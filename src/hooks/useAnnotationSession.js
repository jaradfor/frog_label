import { useState, useEffect, useCallback } from 'react';
import { demoAdapter } from '../adapters/demoAdapter';
import { labelStudioCeAdapter } from '../adapters/labelStudioCeApiAdapter';
import { resolveTaskAudioUrl } from '../api/labelStudio';
import { lsResultsToBoxes } from '../serializers/labelStudioCeResults';

function resolveAudioUrl(task) {
  const audioPath = Object.values(task.data ?? {})[0];
  return resolveTaskAudioUrl(audioPath);
}

export function useAnnotationSession(config) {
  const [currentTask, setCurrentTask] = useState(null);
  const [selectedAudio, setSelectedAudio] = useState(null);
  const [boxes, setBoxes] = useState([]);

  const loadNextTask = useCallback(async () => {
    if (!config) return;

    const adapter = config.demoMode ? demoAdapter : labelStudioCeAdapter;

    try {
      const task = await adapter.getNextTask();
      if (!task || !task.data) {
        console.warn('No task returned or task has no data:', task);
        setCurrentTask(null);
        setSelectedAudio(null);
        setBoxes([]);
        return;
      }

      setCurrentTask(task);
      setSelectedAudio(resolveAudioUrl(task));

      const existing = task.annotations?.[0];
      if (existing?.result?.length) {
        setBoxes(lsResultsToBoxes(existing.result));
      } else {
        setBoxes([]);
      }
    } catch (error) {
      console.error('Error loading task:', error);
      setCurrentTask(null);
      setSelectedAudio(null);
      setBoxes([]);
    }
  }, [config]);

  // Fetch the first task on mount / whenever the session config changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadNextTask();
  }, [loadNextTask]);

  const submitAnnotation = useCallback(async () => {
    if (!currentTask || !config) return;

    const adapter = config.demoMode ? demoAdapter : labelStudioCeAdapter;

    try {
      const existing = currentTask.annotations?.[0];
      if (existing?.id != null) {
        await adapter.updateAnnotation(existing.id, boxes);
      } else {
        await adapter.submitAnnotation(currentTask.id, boxes);
      }
      await loadNextTask();
    } catch (error) {
      console.error('Error submitting annotation:', error);
    }
  }, [currentTask, boxes, loadNextTask, config]);

  return { currentTask, selectedAudio, boxes, setBoxes, submitAnnotation };
}
