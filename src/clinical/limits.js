// Alarm limits. All values are configurable defaults and must be validated by the
// mission's flight surgeons before any operational use.
// A band is { low: [caution, warning, emergency], high: [caution, warning, emergency] };
// an alarm fires when value < low[i] or value > high[i]. null disables that level.

export const SEVERITY = Object.freeze({ ADVISORY: 1, CAUTION: 2, WARNING: 3, EMERGENCY: 4 });
export const SEVERITY_NAME = Object.freeze({ 1: 'advisory', 2: 'caution', 3: 'warning', 4: 'emergency' });

export const VITALS = Object.freeze({
  hr: { label: 'Heart rate', unit: 'bpm', sensor: 'ecg', plausible: [15, 260], decimals: 0 },
  rr: { label: 'Respiratory rate', unit: '/min', sensor: 'resp', plausible: [2, 80], decimals: 0 },
  spo2: { label: 'SpO2', unit: '%', sensor: 'pulseox', plausible: [40, 100], decimals: 0 },
  sys: { label: 'Systolic BP', unit: 'mmHg', sensor: 'bp', plausible: [40, 300], decimals: 0 },
  dia: { label: 'Diastolic BP', unit: 'mmHg', sensor: 'bp', plausible: [20, 200], decimals: 0 },
  temp: { label: 'Core temp', unit: '°C', sensor: 'temp', plausible: [25, 45], decimals: 1 },
});

export const ENV_PARAMS = Object.freeze({
  co2: { label: 'ppCO2', unit: 'mmHg', decimals: 2, band: { low: [null, null, null], high: [3, 6, 10] }, protocol: 'toxic-atmosphere' },
  o2: { label: 'ppO2', unit: 'kPa', decimals: 1, band: { low: [19.5, 18, 16], high: [23.1, 25, 30] }, protocol: 'hypoxia' },
  pressure: { label: 'Cabin pressure', unit: 'kPa', decimals: 1, band: { low: [98, 95, 90], high: [104, 106, 108] }, protocol: 'depressurization' },
  cabinTemp: { label: 'Cabin temp', unit: '°C', decimals: 1, band: { low: [18, 16, 12], high: [27, 30, 35] }, protocol: 'hyperthermia' },
  humidity: { label: 'Humidity', unit: '%RH', decimals: 0, band: { low: [25, 15, null], high: [75, 85, null] }, protocol: null },
  radiation: { label: 'Dose rate', unit: 'µSv/h', decimals: 0, band: { low: [null, null, null], high: [200, 1000, 5000] }, protocol: 'solar-particle-event' },
});

const REST = {
  hr: { low: [50, 40, 30], high: [110, 130, 180] },
  rr: { low: [10, 9, 6], high: [24, 29, 40] },
  spo2: { low: [94, 90, 85], high: [null, null, null] },
  sys: { low: [100, 90, 70], high: [160, 180, 220] },
  dia: { low: [null, 40, null], high: [100, 120, 140] },
  temp: { low: [36, 35, 32], high: [38, 39.5, 41] },
};

const BY_ACTIVITY = {
  rest: REST,
  work: REST,
  sleep: {
    ...REST,
    hr: { low: [40, 35, 25], high: [100, 130, 180] },
    rr: { low: [8, 7, 5], high: [24, 29, 40] },
    sys: { low: [90, 80, 65], high: [160, 180, 220] },
    temp: { low: [35.5, 35, 32], high: [38, 39.5, 41] },
  },
  exercise: {
    ...REST,
    hr: { low: [40, 35, 30], high: 'hrmax' },
    rr: { low: [10, 9, 6], high: [45, 55, 70] },
    spo2: { low: [92, 90, 85], high: [null, null, null] },
    sys: { low: [100, 90, 70], high: [220, 240, 260] },
    dia: { low: [null, 40, null], high: [110, 120, 140] },
    temp: { low: [36, 35, 32], high: [38.7, 39.5, 41] },
  },
  eva: {
    ...REST,
    hr: { low: [40, 35, 30], high: 'hrmax' },
    rr: { low: [10, 9, 6], high: [35, 45, 60] },
    sys: { low: [100, 90, 70], high: [180, 200, 240] },
    temp: { low: [36, 35, 32], high: [38.2, 39, 40.5] },
  },
};

/** Age-predicted maximum heart rate (220 - age) sets exertion limits. */
export function hrMaxBand(age) {
  const max = 220 - age;
  return [Math.round(max * 0.92), max, Math.round(max * 1.1)];
}

/** Crew-specific overrides apply outside exertion, where the exertion limits still protect. */
export function limitsFor(param, activity, crew, overrides = {}) {
  const table = BY_ACTIVITY[activity] ?? REST;
  const band = table[param];
  const resolved = { low: band.low, high: band.high === 'hrmax' ? hrMaxBand(crew.age) : band.high };
  const exertion = activity === 'exercise' || activity === 'eva';
  const override = overrides[param];
  if (override && !exertion) return { low: override.low ?? resolved.low, high: override.high ?? resolved.high };
  return resolved;
}

/** Returns { severity, direction, limit } for the worst band breached, or null. */
export function evaluateBand(value, band) {
  for (const level of [2, 1, 0]) {
    const lo = band.low[level];
    if (lo !== null && lo !== undefined && value < lo) return { severity: level + 2, direction: 'low', limit: lo };
    const hi = band.high[level];
    if (hi !== null && hi !== undefined && value > hi) return { severity: level + 2, direction: 'high', limit: hi };
  }
  return null;
}

export function isPlausible(param, value) {
  const [min, max] = VITALS[param].plausible;
  return Number.isFinite(value) && value >= min && value <= max;
}

/** Validates a crew override. Returns an error string, or null when acceptable. */
export function validateOverride(param, override) {
  if (typeof param !== 'string' || !Object.hasOwn(VITALS, param)) return `unknown parameter: ${param}`;
  const meta = VITALS[param];
  if (override === null || typeof override !== 'object') return 'override must be an object';
  for (const side of ['low', 'high']) {
    const levels = override?.[side];
    if (levels === undefined) continue;
    if (!Array.isArray(levels) || levels.length !== 3) return `${side} must be [caution, warning, emergency]`;
    const set = levels.filter((v) => v !== null);
    if (set.some((v) => !isPlausible(param, v))) return `${side} limits must be within ${meta.plausible.join('–')} ${meta.unit}`;
    for (let i = 1; i < set.length; i++) {
      const ordered = side === 'low' ? set[i] < set[i - 1] : set[i] > set[i - 1];
      if (!ordered) return `${side} limits must get strictly more extreme from caution to emergency`;
    }
  }
  if (override.low === undefined && override.high === undefined) return 'provide low and/or high limits';
  return null;
}
