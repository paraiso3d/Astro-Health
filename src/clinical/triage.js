import { SEVERITY } from './limits.js';

// Symptom catalog. redFlag symptoms are emergencies regardless of the reported severity.
export const SYMPTOMS = Object.freeze({
  'chest-pain': { label: 'Chest pain or pressure', redFlag: true, protocol: 'chest-pain' },
  'dyspnea': { label: 'Shortness of breath', redFlag: true, protocol: 'hypoxia' },
  'syncope': { label: 'Fainting or near-fainting', redFlag: true, protocol: 'hypotension-syncope' },
  'neuro-deficit': { label: 'Weakness, numbness or trouble speaking', redFlag: true, protocol: 'dcs' },
  'anaphylaxis': { label: 'Throat swelling or widespread hives', redFlag: true, protocol: 'anaphylaxis' },
  'joint-pain-eva': { label: 'Joint pain after EVA', redFlag: true, protocol: 'dcs' },
  'vision-change': { label: 'Vision change', urgent: true, protocol: 'sans' },
  'severe-headache': { label: 'Severe headache', urgent: true, protocol: 'sans' },
  'flank-pain': { label: 'Flank pain (possible renal stone)', urgent: true, protocol: 'renal-stone' },
  'palpitations': { label: 'Palpitations', urgent: true, protocol: 'arrhythmia' },
  'fever': { label: 'Fever or chills', urgent: true, protocol: 'fever-sepsis' },
  'eye-injury': { label: 'Eye injury or foreign body', urgent: true, protocol: 'eye-injury' },
  'motion-sickness': { label: 'Space motion sickness', protocol: 'motion-sickness' },
  'headache': { label: 'Headache' },
  'back-pain': { label: 'Back pain' },
  'congestion': { label: 'Nasal congestion' },
  'insomnia': { label: 'Trouble sleeping' },
  'skin-irritation': { label: 'Skin irritation' },
  'low-mood': { label: 'Low mood or anxiety', protocol: 'behavioral' },
  'other': { label: 'Other symptom' },
});

/** severity is the 0-10 pain/discomfort score. Unknown codes are refused, never ignored. */
export function triageSymptom(code, severity) {
  const s = typeof code === 'string' && Object.hasOwn(SYMPTOMS, code) ? SYMPTOMS[code] : null;
  if (!s) throw new RangeError(`unknown symptom code: ${code}`);
  let triage = 'routine';
  if (s.redFlag) triage = 'emergency';
  else if (s.urgent || severity >= 7) triage = 'urgent';
  return { triage, label: s.label, protocol: s.protocol ?? null };
}

export const ALERT_SEVERITY_FOR_TRIAGE = { emergency: SEVERITY.WARNING, urgent: SEVERITY.CAUTION, routine: SEVERITY.ADVISORY };
