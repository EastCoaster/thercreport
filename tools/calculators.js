/* Calculators utilities for The RC Report
 * Exports functions for gear ratio, rollout, comparisons, and top speed estimation.
 * Functions are exported as ES module exports and attached to window.Calculators for quick access.
 */

// Compute basic gear ratio (motor revolutions per wheel revolution)
export function computeGearRatio(pinionTeeth, spurTeeth) {
  const p = Number(pinionTeeth) || 0;
  const s = Number(spurTeeth) || 0;
  if (p <= 0 || s <= 0) return null;
  // motor revs per wheel rev = spur / pinion
  return s / p;
}

// Multiply an array of stage ratios (each stage is { pinion, spur } or a numeric ratio)
export function computeFinalDriveRatio(stages = []) {
  if (!Array.isArray(stages) || stages.length === 0) return null;
  return stages.reduce((acc, stage) => {
    if (!stage) return acc;
    if (typeof stage === 'number') return acc * stage;
    if (stage.pinion && stage.spur) {
      const ratio = computeGearRatio(stage.pinion, stage.spur);
      return acc * (ratio || 1);
    }
    return acc;
  }, 1);
}

export function wheelCircumferenceMm(diameterMm) {
  const d = Number(diameterMm) || 0;
  if (d <= 0) return null;
  return Math.PI * d;
}

// Rollout in mm per motor revolution
export function computeRolloutMm(finalDriveRatio, wheelDiameterMm) {
  const f = Number(finalDriveRatio) || 0;
  const circ = wheelCircumferenceMm(wheelDiameterMm);
  if (!f || !circ) return null;
  // distance per motor rev = wheel circumference / motorRevPerWheelRev
  return circ / f;
}

export function percentChange(before, after) {
  const b = Number(before);
  const a = Number(after);
  if (!isFinite(b) || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

// Compare two gearing setups. Each spec: { pinion, spur, stages?, wheelDiameterMm }
export function compareGearing(beforeSpec = {}, afterSpec = {}) {
  // If stages provided, compute final drive from stages array; otherwise use pinion+spur
  function finalRatioFromSpec(spec) {
    if (!spec) return null;
    if (Array.isArray(spec.stages) && spec.stages.length > 0) {
      return computeFinalDriveRatio(spec.stages);
    }
    if (spec.pinion && spec.spur) return computeGearRatio(spec.pinion, spec.spur);
    return null;
  }

  const beforeFinal = finalRatioFromSpec(beforeSpec);
  const afterFinal = finalRatioFromSpec(afterSpec);
  const beforeRollout = (beforeFinal && beforeSpec.wheelDiameterMm) ? computeRolloutMm(beforeFinal, beforeSpec.wheelDiameterMm) : null;
  const afterRollout = (afterFinal && afterSpec.wheelDiameterMm) ? computeRolloutMm(afterFinal, afterSpec.wheelDiameterMm) : null;

  return {
    before: {
      finalDriveRatio: beforeFinal,
      rolloutMm: beforeRollout,
    },
    after: {
      finalDriveRatio: afterFinal,
      rolloutMm: afterRollout,
    },
    change: {
      finalDrivePercent: (beforeFinal && afterFinal) ? percentChange(beforeFinal, afterFinal) : null,
      rolloutPercent: (beforeRollout && afterRollout) ? percentChange(beforeRollout, afterRollout) : null,
    }
  };
}

// Top speed estimation for electric brushless cars
// Inputs:
//  - kv: motor KV (RPM per volt)
//  - voltage: battery pack voltage (V)
//  - finalDriveRatio: motor revs per wheel rev (product of gearing)
//  - wheelDiameterMm: wheel diameter in mm (measured with mounted tire)
//  - efficiency: drivetrain/airloss factor (0-1), default 0.95
// Returns { speedKph, speedMph, motorRpm, wheelRpm }
export function estimateTopSpeed({ kv, voltage, finalDriveRatio, wheelDiameterMm, efficiency = 0.95 }) {
  const KV = Number(kv) || 0;
  const V = Number(voltage) || 0;
  const F = Number(finalDriveRatio) || 0;
  const D = Number(wheelDiameterMm) || 0;

  if (KV <= 0 || V <= 0 || F <= 0 || D <= 0) return null;

  const motorRpm = KV * V; // theoretical no-load motor rpm
  const wheelRpm = motorRpm / F;
  const circM = (wheelCircumferenceMm(D) / 1000); // meters
  // speed (km/h) = wheelRpm * circumference_m * 0.06, then apply efficiency
  const speedKph = wheelRpm * circM * 0.06 * Number(efficiency);
  const speedMph = speedKph / 1.609344;

  return {
    speedKph: Number(speedKph.toFixed(2)),
    speedMph: Number(speedMph.toFixed(2)),
    motorRpm: Math.round(motorRpm),
    wheelRpm: Math.round(wheelRpm)
  };
}

// Attach to window for quick usage in non-module contexts
if (typeof window !== 'undefined') {
  window.Calculators = window.Calculators || {};
  window.Calculators.computeGearRatio = computeGearRatio;
  window.Calculators.computeFinalDriveRatio = computeFinalDriveRatio;
  window.Calculators.wheelCircumferenceMm = wheelCircumferenceMm;
  window.Calculators.computeRolloutMm = computeRolloutMm;
  window.Calculators.percentChange = percentChange;
  window.Calculators.compareGearing = compareGearing;
  window.Calculators.estimateTopSpeed = estimateTopSpeed;
}
