const INFERNO_POINTS = [
  [0.001462, 0.000466, 0.013866],
  [0.087411, 0.044556, 0.125312],
  [0.227397, 0.051716, 0.30226],
  [0.416331, 0.039885, 0.398396],
  [0.606347, 0.065886, 0.348726],
  [0.783021, 0.155536, 0.228386],
  [0.911683, 0.312857, 0.093573],
  [0.979644, 0.526563, 0.022143],
  [0.9844, 0.775156, 0.176125],
  [0.988362, 0.998364, 0.644924],
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function generateInferno() {
  const map = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const scaled = t * (INFERNO_POINTS.length - 1);
    const lo = Math.floor(scaled);
    const hi = Math.min(lo + 1, INFERNO_POINTS.length - 1);
    const frac = scaled - lo;
    map.push([
      lerp(INFERNO_POINTS[lo][0], INFERNO_POINTS[hi][0], frac),
      lerp(INFERNO_POINTS[lo][1], INFERNO_POINTS[hi][1], frac),
      lerp(INFERNO_POINTS[lo][2], INFERNO_POINTS[hi][2], frac),
      1,
    ]);
  }
  return map;
}

export default generateInferno;
