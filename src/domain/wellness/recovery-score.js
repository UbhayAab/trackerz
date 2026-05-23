// Approximates a 0-100 recovery score from sleep, optional HRV, and soreness.
// Pure: no IO.

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function computeRecovery({ sleepHours, restingHRV, soreness1to5 } = {}) {
  const sleep = Number(sleepHours);
  const soreness = Number(soreness1to5);

  // Sleep contributes up to 50 points: 8h is ideal, <5h drops to 0, >9h saturates.
  let sleepPart = 0;
  if (Number.isFinite(sleep)) {
    if (sleep >= 8) sleepPart = 50;
    else if (sleep <= 4) sleepPart = 0;
    else sleepPart = ((sleep - 4) / 4) * 50;
  }

  // Soreness contributes up to 30 points (5 = wrecked → 0, 1 = none → 30).
  let sorenessPart = 30;
  if (Number.isFinite(soreness)) {
    const s = clamp(soreness, 1, 5);
    sorenessPart = ((5 - s) / 4) * 30;
  }

  // HRV (optional) contributes up to 20 points. Treat 70ms+ as full credit,
  // 30ms or lower as zero, linear between. If omitted, give half credit (10).
  let hrvPart = 10;
  if (Number.isFinite(Number(restingHRV))) {
    const hrv = Number(restingHRV);
    if (hrv >= 70) hrvPart = 20;
    else if (hrv <= 30) hrvPart = 0;
    else hrvPart = ((hrv - 30) / 40) * 20;
  }

  const score = clamp(Math.round(sleepPart + sorenessPart + hrvPart), 0, 100);
  return score;
}
