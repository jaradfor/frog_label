import { useState, useEffect, useCallback, useRef } from 'react';
import { demoAdapter } from '../adapters/demoAdapter';
import { labelStudioCeAdapter } from '../adapters/labelStudioCeApiAdapter';
import { resolveTaskAudioUrl } from '../api/labelStudio';
import { lsResultsToBoxes } from '../serializers/labelStudioCeResults';
import { track, setTelemetryTaskId } from '../telemetry/telemetry';

function resolveAudioUrl(task) {
  const audioPath = Object.values(task.data ?? {})[0];
  return resolveTaskAudioUrl(audioPath);
}

export function useAnnotationSession(config) {
  const [currentTask, setCurrentTask] = useState(null);
  const [selectedAudio, setSelectedAudio] = useState(null);
  const [boxes, setBoxes] = useState([]);
  const taskStartedAtRef = useRef(null);

  const loadNextTask = useCallback(async () => {
    if (!config) return;

    const adapter = config.demoMode ? demoAdapter : labelStudioCeAdapter;

    try {
      const task = await adapter.getNextTask();
      if (!task || !task.data) {
        console.warn('No task returned or task has no data:', task);
        setTelemetryTaskId(null);
        track('tasks_exhausted', { demoMode: config.demoMode });
        setCurrentTask(null);
        setSelectedAudio(null);
        setBoxes([]);
        return;
      }

      setCurrentTask(task);
      setSelectedAudio(resolveAudioUrl(task));
      setTelemetryTaskId(task.id);
      taskStartedAtRef.current = Date.now();

      const existing = task.annotations?.[0];
      const startingBoxes = existing?.result?.length ? lsResultsToBoxes(existing.result) : [];
      setBoxes(startingBoxes);
      track('task_started', { demoMode: config.demoMode, startingBoxCount: startingBoxes.length });
    } catch (error) {
      console.error('Error loading task:', error);
      setTelemetryTaskId(null);
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
    const wallClockMs = taskStartedAtRef.current ? Date.now() - taskStartedAtRef.current : null;

    try {
      const existing = currentTask.annotations?.[0];
      if (existing?.id != null) {
        await adapter.updateAnnotation(existing.id, boxes);
      } else {
        await adapter.submitAnnotation(currentTask.id, boxes);
      }
      track('task_submitted', {
        success: true,
        boxCount: boxes.length,
        wallClockMs,
        demoMode: config.demoMode,
      });
      await loadNextTask();
    } catch (error) {
      console.error('Error submitting annotation:', error);
      track('task_submitted', {
        success: false,
        boxCount: boxes.length,
        wallClockMs,
        demoMode: config.demoMode,
      });
    }
  }, [currentTask, boxes, loadNextTask, config]);

  return { currentTask, selectedAudio, boxes, setBoxes, submitAnnotation };
}
