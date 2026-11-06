// National Early Warning Score 2 (Royal College of Physicians, 2017), SpO2 scale 1.
// NEWS2 is validated for acute hospital patients, not for microgravity. It is used
// here as a screening aid, and is not computed as valid during or just after exertion.

const band = (value, rows) => rows.find(([test]) => test(value))[1];

const scoreRr = (v) => band(Math.round(v), [[(x) => x <= 8, 3], [(x) => x <= 11, 1], [(x) => x <= 20, 0], [(x) => x <= 24, 2], [() => true, 3]]);
const scoreSpo2 = (v) => band(Math.round(v), [[(x) => x <= 91, 3], [(x) => x <= 93, 2], [(x) => x <= 95, 1], [() => true, 0]]);
const scoreSys = (v) => band(Math.round(v), [[(x) => x <= 90, 3], [(x) => x <= 100, 2], [(x) => x <= 110, 1], [(x) => x <= 219, 0], [() => true, 3]]);
const scoreHr = (v) => band(Math.round(v), [[(x) => x <= 40, 3], [(x) => x <= 50, 1], [(x) => x <= 90, 0], [(x) => x <= 110, 1], [(x) => x <= 130, 2], [() => true, 3]]);
const scoreTemp = (v) => {
  const t = Math.round(v * 10) / 10;
  return band(t, [[(x) => x <= 35.0, 3], [(x) => x <= 36.0, 1], [(x) => x <= 38.0, 0], [(x) => x <= 39.0, 1], [() => true, 2]]);
};

/**
 * Missing inputs make the result incomplete: an incomplete score never reports
 * a reassuring "low" risk, because a partial sum can hide real deterioration.
 */
export function computeNews2({ rr, spo2, onOxygen = false, sys, hr, avpu = 'A', temp }) {
  const components = {};
  const missing = [];
  const add = (name, value, fn) => {
    if (value === null || value === undefined || !Number.isFinite(value)) missing.push(name);
    else components[name] = fn(value);
  };
  add('rr', rr, scoreRr);
  add('spo2', spo2, scoreSpo2);
  add('sys', sys, scoreSys);
  add('hr', hr, scoreHr);
  add('temp', temp, scoreTemp);
  components.oxygen = onOxygen ? 2 : 0;
  components.consciousness = avpu === 'A' ? 0 : 3;

  const score = Object.values(components).reduce((a, b) => a + b, 0);
  const anyThree = Object.values(components).some((c) => c === 3);
  const complete = missing.length === 0;

  let risk;
  if (score >= 7) risk = 'high';
  else if (score >= 5) risk = 'medium';
  else if (!complete) risk = 'unknown';
  else if (anyThree) risk = 'low-medium';
  else risk = 'low';

  return { score, risk, complete, missing, components };
}
