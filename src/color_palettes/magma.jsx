const MAGMA_POINTS = [
  [0.001462, 0.000466, 0.013866],
  [0.089154, 0.044595, 0.132868],
  [0.232077, 0.059889, 0.300564],
  [0.416209, 0.054848, 0.377006],
  [0.59443, 0.091312, 0.355765],
  [0.764193, 0.176004, 0.281904],
  [0.904281, 0.31961, 0.197297],
  [0.988332, 0.532683, 0.073322],
  [0.987053, 0.784612, 0.144975],
  [0.987792, 0.991602, 0.749504],
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function generateMagma() {
  const map = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const scaled = t * (MAGMA_POINTS.length - 1);
    const lo = Math.floor(scaled);
    const hi = Math.min(lo + 1, MAGMA_POINTS.length - 1);
    const frac = scaled - lo;
    map.push([
      lerp(MAGMA_POINTS[lo][0], MAGMA_POINTS[hi][0], frac),
      lerp(MAGMA_POINTS[lo][1], MAGMA_POINTS[hi][1], frac),
      lerp(MAGMA_POINTS[lo][2], MAGMA_POINTS[hi][2], frac),
      1,
    ]);
  }
  return map;
}

export default generateMagma;
