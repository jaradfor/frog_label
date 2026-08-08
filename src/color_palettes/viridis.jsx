// Viridis control points (from matplotlib), sampled at even intervals
const VIRIDIS_POINTS = [
  [0.267004, 0.004874, 0.329415],
  [0.282623, 0.140926, 0.457517],
  [0.253935, 0.265254, 0.529983],
  [0.163625, 0.471133, 0.558148],
  [0.134692, 0.658636, 0.517649],
  [0.477504, 0.821444, 0.318195],
  [0.993248, 0.906157, 0.143936],
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function generateViridis() {
  const points = VIRIDIS_POINTS;
  const n = 256;
  const map = [];

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const scaled = t * (points.length - 1);
    const lo = Math.floor(scaled);
    const hi = Math.min(lo + 1, points.length - 1);
    const frac = scaled - lo;

    const r = lerp(points[lo][0], points[hi][0], frac);
    const g = lerp(points[lo][1], points[hi][1], frac);
    const b = lerp(points[lo][2], points[hi][2], frac);

    map.push([r, g, b, 1]);
  }

  return map;
}

export default generateViridis;
