import { SEVERITY } from './limits.js';

// NASA-STD-3001 career effective dose limit.
export const CAREER_DOSE_LIMIT_MSV = 600;

/** Dose status and the end-of-mission projection at the recent average daily rate. */
export function doseStatus({ cumulativeMsv, avgMsvPerDay, daysRemaining, limitMsv = CAREER_DOSE_LIMIT_MSV }) {
  const projectedMsv = cumulativeMsv + avgMsvPerDay * Math.max(daysRemaining, 0);
  return {
    cumulativeMsv,
    limitMsv,
    pct: (cumulativeMsv / limitMsv) * 100,
    projectedMsv,
    projectedPct: (projectedMsv / limitMsv) * 100,
    daysToLimit: avgMsvPerDay > 0 ? Math.max(0, (limitMsv - cumulativeMsv) / avgMsvPerDay) : null,
  };
}

export function doseCondition(crew, dose) {
  const common = { category: 'clinical', crewId: crew.id, persistMs: 0, protocol: 'solar-particle-event', value: dose.cumulativeMsv, unit: 'mSv' };
  if (dose.pct >= 100) return { ...common, severity: SEVERITY.WARNING, title: 'Career dose limit exceeded', message: `${crew.name}: ${dose.cumulativeMsv.toFixed(0)} mSv exceeds the ${dose.limitMsv} mSv limit.` };
  if (dose.pct >= 90) return { ...common, severity: SEVERITY.CAUTION, title: 'Career dose near limit', message: `${crew.name}: ${dose.pct.toFixed(0)}% of the career dose limit.` };
  if (dose.projectedPct > 100) return { ...common, severity: SEVERITY.ADVISORY, title: 'Projected dose over limit', message: `${crew.name}: projected ${dose.projectedMsv.toFixed(0)} mSv by end of mission (limit ${dose.limitMsv}).` };
  return null;
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Fatigue screening from sleep debt against an 8 h need and vigilance-test lapses. */
export function fatigueStatus(logs) {
  const recent = logs.slice(-3);
  if (recent.length === 0) return { level: 'unknown', score: null, sleepDebtH: null, lastSleepH: null };
  const sleepDebtH = recent.reduce((debt, log) => debt + Math.max(0, 8 - log.sleepH), 0);
  const lapses = avg(recent.map((l) => l.pvtLapses ?? 0));
  const score = Math.min(100, Math.round(sleepDebtH * 7 + lapses * 4));
  const level = score >= 70 ? 'severe' : score >= 45 ? 'high' : score >= 25 ? 'moderate' : 'low';
  return { level, score, sleepDebtH, lastSleepH: recent.at(-1).sleepH };
}

/**
 * Illustrative estimate: unmitigated loss of about 1.25 %/month in weight-bearing bone
 * (the 1-1.5 % literature range), halved at full countermeasure adherence.
 * It prompts a scan and never replaces one.
 */
export function boneEstimate(logs, targetMin = 120) {
  if (logs.length === 0) return { estLossPct: null, adherencePct: null };
  const adherence = avg(logs.map((l) => Math.min(1, l.exerciseMin / targetMin)));
  const monthlyRate = 1.25 * (1 - 0.5 * adherence);
  return { estLossPct: monthlyRate * (logs.length / 30), adherencePct: adherence * 100, monthlyRatePct: monthlyRate };
}

/** Longitudinal findings from daily logs. Needs a minimum of data before it speaks. */
export function evaluateLongitudinal(crew, logs, baselineWeightKg) {
  const findings = [];
  const add = (code, severity, title, message) => findings.push({ code, severity, title, message });
  if (logs.length === 0) return findings;

  const week = logs.slice(-7);
  const prior = logs.slice(-14, -7);
  const fatigue = fatigueStatus(logs);
  if (fatigue.level === 'severe') add('fatigue', SEVERITY.CAUTION, 'Severe fatigue risk', `3-day sleep debt ${fatigue.sleepDebtH.toFixed(1)} h, fatigue score ${fatigue.score}.`);
  else if (fatigue.level === 'high') add('fatigue', SEVERITY.ADVISORY, 'High fatigue risk', `3-day sleep debt ${fatigue.sleepDebtH.toFixed(1)} h, fatigue score ${fatigue.score}.`);

  const water = avg(week.map((l) => l.waterL));
  if (week.length >= 3 && water < 2.0) add('hydration', SEVERITY.ADVISORY, 'Low fluid intake', `Average ${water.toFixed(1)} L/day over ${week.length} days; raises renal stone risk.`);

  const exercise = avg(week.map((l) => l.exerciseMin));
  if (week.length >= 3 && exercise < 90) add('exercise', SEVERITY.ADVISORY, 'Exercise below prescription', `Average ${exercise.toFixed(0)} min/day against a 120 min target.`);

  const kcal = avg(week.map((l) => l.kcal));
  if (week.length >= 3 && kcal < crew.kcalTarget * 0.8) add('nutrition', SEVERITY.ADVISORY, 'Low energy intake', `Average ${kcal.toFixed(0)} kcal/day against a ${crew.kcalTarget} kcal target.`);

  const weight = logs.at(-1).weightKg;
  if (Number.isFinite(weight) && baselineWeightKg > 0) {
    const lossPct = ((baselineWeightKg - weight) / baselineWeightKg) * 100;
    if (lossPct >= 10) add('weight', SEVERITY.CAUTION, 'Significant body mass loss', `${lossPct.toFixed(1)}% below pre-flight mass.`);
    else if (lossPct >= 5) add('weight', SEVERITY.ADVISORY, 'Body mass loss', `${lossPct.toFixed(1)}% below pre-flight mass.`);
  }

  if (week.length >= 5 && prior.length >= 5) {
    const moodNow = avg(week.map((l) => l.mood));
    const moodBefore = avg(prior.map((l) => l.mood));
    if (moodBefore - moodNow >= 1.5) add('mood', SEVERITY.ADVISORY, 'Mood declining', `7-day mood ${moodNow.toFixed(1)}/10, down from ${moodBefore.toFixed(1)}. Consider a private conference.`);
  }
  const stress = avg(week.map((l) => l.stress));
  if (week.length >= 3 && stress >= 7) add('stress', SEVERITY.ADVISORY, 'Sustained high stress', `7-day stress average ${stress.toFixed(1)}/10.`);
  return findings;
}

/** Spaceflight-associated neuro-ocular syndrome screening from an eye exam. */
export function evaluateOcularExam(exam) {
  const findings = [];
  if (exam.frisenGrade >= 3) findings.push({ severity: SEVERITY.WARNING, title: 'Optic disc edema, Frisén grade ' + exam.frisenGrade, message: 'Marked optic disc edema. Consult flight surgeon.' });
  else if (exam.frisenGrade >= 1) findings.push({ severity: SEVERITY.ADVISORY, title: 'Optic disc edema, Frisén grade ' + exam.frisenGrade, message: 'Possible SANS. Increase the ocular exam frequency.' });
  if (exam.acuityChange >= 2) findings.push({ severity: SEVERITY.CAUTION, title: 'Near vision change', message: `Near acuity worse by ${exam.acuityChange} lines.` });
  return findings;
}
