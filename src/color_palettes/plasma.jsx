const PLASMA_POINTS = [
  [0.050383, 0.029803, 0.527975],
  [0.203385, 0.0197, 0.620959],
  [0.349667, 0.012316, 0.667936],
  [0.487697, 0.013882, 0.661464],
  [0.614704, 0.067295, 0.601385],
  [0.726797, 0.161803, 0.509404],
  [0.820128, 0.268953, 0.406485],
  [0.899244, 0.382861, 0.30229],
  [0.960949, 0.50939, 0.197207],
  [0.994738, 0.658678, 0.100361],
  [0.974443, 0.824257, 0.075356],
  [0.940015, 0.975158, 0.131326],
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function generatePlasma() {
  const map = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const scaled = t * (PLASMA_POINTS.length - 1);
    const lo = Math.floor(scaled);
    const hi = Math.min(lo + 1, PLASMA_POINTS.length - 1);
    const frac = scaled - lo;
    map.push([
      lerp(PLASMA_POINTS[lo][0], PLASMA_POINTS[hi][0], frac),
      lerp(PLASMA_POINTS[lo][1], PLASMA_POINTS[hi][1], frac),
      lerp(PLASMA_POINTS[lo][2], PLASMA_POINTS[hi][2], frac),
      1,
    ]);
  }
  return map;
}

export default generatePlasma;
