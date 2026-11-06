import { SEVERITY } from './limits.js';

const RANK = { GO: 0, RESTRICTED: 1, 'NO-GO': 2, UNKNOWN: 3 };
const SYMPTOM_RANK = { routine: 1, urgent: 2, emergency: 3 };

const worst = (reasons) => reasons.reduce((s, r) => (RANK[r.status] > RANK[s] ? r.status : s), 'GO');

/**
 * Fit-for-duty and EVA go/no-go. Fails safe: missing data is UNKNOWN and never GO,
 * and these results support a flight surgeon's decision rather than replace it.
 */
export function computeReadiness({ news, activeAlerts, fatigue, sedationActive, sedationWithin24h, openSymptoms, dose, dataAgeMs, hold, env, ocularRestricted }) {
  const duty = [];
  const eva = [];
  const noData = dataAgeMs === null || dataAgeMs > 60000;

  if (noData) duty.push({ status: 'UNKNOWN', reason: 'No recent telemetry' });
  if (hold) duty.push({ status: 'NO-GO', reason: `Medical hold: ${hold.reason}` });

  for (const a of activeAlerts) {
    if (a.category === 'clinical') {
      if (a.severity >= SEVERITY.WARNING) duty.push({ status: 'NO-GO', reason: a.title });
      else if (a.severity === SEVERITY.CAUTION) duty.push({ status: 'RESTRICTED', reason: a.title });
      else if (/^(trend|baseline):/.test(a.key ?? '')) eva.push({ status: 'NO-GO', reason: `Unexplained physiological change: ${a.title}` });
    } else if (a.category === 'technical') {
      eva.push({ status: 'NO-GO', reason: `Biomedical monitoring issue: ${a.title}` });
    }
  }

  if (news?.valid) {
    if (news.score >= 7) duty.push({ status: 'NO-GO', reason: `NEWS2 ${news.score}` });
    else if (news.score >= 5) duty.push({ status: 'RESTRICTED', reason: `NEWS2 ${news.score}` });
    else if (news.score > 2) eva.push({ status: 'NO-GO', reason: `NEWS2 ${news.score} (EVA requires 2 or less)` });
    if (!news.complete) eva.push({ status: 'UNKNOWN', reason: `Incomplete vitals: ${news.missing.join(', ')}` });
  }

  for (const s of openSymptoms) {
    const rank = SYMPTOM_RANK[s.triage];
    if (rank >= 3) duty.push({ status: 'NO-GO', reason: `Symptom: ${s.label}` });
    else if (rank === 2) duty.push({ status: 'RESTRICTED', reason: `Symptom: ${s.label}` });
    else eva.push({ status: 'NO-GO', reason: `Open symptom: ${s.label}` });
  }

  if (sedationActive) duty.push({ status: 'RESTRICTED', reason: 'Sedating medication active' });
  if (sedationWithin24h) eva.push({ status: 'NO-GO', reason: 'Sedating medication within 24 h' });

  if (fatigue?.level === 'severe') duty.push({ status: 'RESTRICTED', reason: 'Severe fatigue risk' });
  if (fatigue?.level === 'high') eva.push({ status: 'NO-GO', reason: 'High fatigue risk' });
  if (!fatigue || fatigue.lastSleepH === null || fatigue.lastSleepH === undefined) eva.push({ status: 'UNKNOWN', reason: 'No recent sleep log' });
  else if (fatigue.lastSleepH < 6) eva.push({ status: 'NO-GO', reason: `Slept ${fatigue.lastSleepH.toFixed(1)} h (EVA requires 6 h)` });

  if (dose && dose.pct >= 100) eva.push({ status: 'NO-GO', reason: 'Career dose limit reached' });
  else if (dose && dose.pct >= 95) eva.push({ status: 'NO-GO', reason: 'Career dose within 5% of limit' });
  if (ocularRestricted) eva.push({ status: 'NO-GO', reason: 'Ocular exam finding' });
  if (env?.radiationAlarm) eva.push({ status: 'NO-GO', reason: 'Radiation alarm active' });
  if (env?.atmosphereAlarm) eva.push({ status: 'NO-GO', reason: 'Cabin atmosphere alarm active' });

  const dutyStatus = worst(duty);
  const evaReasons = dutyStatus === 'GO' ? eva : [{ status: dutyStatus === 'RESTRICTED' ? 'NO-GO' : dutyStatus, reason: 'Not fully fit for duty' }, ...eva];
  const unique = (list) => [...new Set(list.map((r) => r.reason))];
  return {
    duty: { status: dutyStatus, reasons: unique(duty) },
    eva: { status: worst(evaReasons), reasons: unique(evaReasons) },
  };
}
