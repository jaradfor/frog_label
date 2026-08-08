import { createFrogBox } from '../domain/frogBox';

export function boxesToLsResults(boxes) {
  return boxes.map((box) => ({
    type: 'rectanglelabels',
    value: {
      start: box.startTime,
      end: box.endTime,
      startFreq: box.startFreq,
      endFreq: box.endFreq,
      labels: [box.code],
    },
  }));
}

export function lsResultsToBoxes(results) {
  if (!results?.length) return [];

  return results
    .filter((result) => result.type === 'rectanglelabels')
    .map((result, index) =>
      createFrogBox({
        id: result.id ?? Date.now() + index,
        startTime: result.value.start,
        endTime: result.value.end,
        startFreq: result.value.startFreq,
        endFreq: result.value.endFreq,
        code: result.value.labels?.[0] ?? '',
      }),
    );
}
