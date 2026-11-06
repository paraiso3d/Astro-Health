// Mission pharmacy. Doses are typical adult reference values, and the flight
// surgeon must validate them against the actual flight formulary.
export const FORMULARY = Object.freeze([
  { id: 'acetaminophen', name: 'Acetaminophen', dose: '500 mg tablet', drugClass: 'analgesic', minIntervalH: 6, maxPer24h: 4, selfAdmin: true, qty: 200, expiryDays: 500 },
  { id: 'ibuprofen', name: 'Ibuprofen', dose: '400 mg tablet', drugClass: 'nsaid', minIntervalH: 6, maxPer24h: 3, selfAdmin: true, qty: 180, expiryDays: 500 },
  { id: 'aspirin', name: 'Aspirin', dose: '325 mg tablet', drugClass: 'nsaid', minIntervalH: 24, maxPer24h: 1, selfAdmin: false, qty: 30, expiryDays: 500 },
  { id: 'promethazine', name: 'Promethazine', dose: '25 mg', drugClass: 'antiemetic', minIntervalH: 12, maxPer24h: 2, sedationH: 12, selfAdmin: false, qty: 40, expiryDays: 400 },
  { id: 'meclizine', name: 'Meclizine', dose: '25 mg tablet', drugClass: 'antiemetic', minIntervalH: 24, maxPer24h: 1, sedationH: 8, selfAdmin: true, qty: 60, expiryDays: 500 },
  { id: 'zolpidem', name: 'Zolpidem', dose: '5 mg tablet', drugClass: 'hypnotic', minIntervalH: 24, maxPer24h: 1, sedationH: 8, selfAdmin: false, qty: 8, expiryDays: 300 },
  { id: 'diphenhydramine', name: 'Diphenhydramine', dose: '25 mg capsule', drugClass: 'antihistamine', minIntervalH: 6, maxPer24h: 4, sedationH: 8, selfAdmin: true, qty: 60, expiryDays: 25 },
  { id: 'loperamide', name: 'Loperamide', dose: '2 mg capsule', drugClass: 'antidiarrheal', minIntervalH: 4, maxPer24h: 4, selfAdmin: true, qty: 48, expiryDays: 500 },
  { id: 'amoxicillin', name: 'Amoxicillin', dose: '500 mg capsule', drugClass: 'penicillin', minIntervalH: 8, maxPer24h: 3, selfAdmin: false, qty: 42, expiryDays: 300 },
  { id: 'ceftriaxone', name: 'Ceftriaxone', dose: '1 g IV/IM', drugClass: 'cephalosporin', minIntervalH: 24, maxPer24h: 1, selfAdmin: false, qty: 10, expiryDays: -5 },
  { id: 'epinephrine', name: 'Epinephrine auto-injector', dose: '0.3 mg IM', drugClass: 'emergency', minIntervalH: 5 / 60, maxPer24h: 6, selfAdmin: true, qty: 6, expiryDays: 300, emergency: true },
]);

const HOUR = 3600000;
const CROSS_REACTIVE = { penicillin: ['cephalosporin'] };
const INTERACTIONS = [
  { classes: ['nsaid', 'nsaid'], message: 'Two NSAIDs together raise bleeding and GI risk.' },
];

/**
 * Safety check before administering a dose.
 * blocks stop the dose unless overridden with a recorded reason; hard stops can't be overridden;
 * warnings inform without stopping. An emergency drug's interval and expiry only warn, because
 * withholding epinephrine in anaphylaxis is more dangerous than either.
 */
export function checkAdministration({ med, crew, history, now }) {
  const blocks = [];
  const warnings = [];
  const hardStops = [];

  if (med.qty <= 0) hardStops.push('Out of stock');

  const allergies = crew.allergies ?? [];
  if (allergies.includes(med.drugClass) || allergies.includes(med.id)) {
    blocks.push(`ALLERGY: ${crew.name} has a recorded ${med.drugClass} allergy`);
  }
  for (const allergy of allergies) {
    if (CROSS_REACTIVE[allergy]?.includes(med.drugClass)) warnings.push(`Possible cross-reactivity with recorded ${allergy} allergy`);
  }

  const expired = med.expiresAt <= now;
  if (expired) (med.emergency ? warnings : blocks).push(`Expired on ${new Date(med.expiresAt).toISOString().slice(0, 10)}`);

  const sameDrug = history.filter((h) => h.medId === med.id);
  const last = sameDrug.reduce((latest, h) => Math.max(latest, h.ts), 0);
  if (last && now - last < med.minIntervalH * HOUR) {
    const waitMin = Math.ceil((med.minIntervalH * HOUR - (now - last)) / 60000);
    (med.emergency ? warnings : blocks).push(`Too soon: last dose ${Math.round((now - last) / 60000)} min ago, wait ${waitMin} min`);
  }
  const in24h = sameDrug.filter((h) => now - h.ts < 24 * HOUR).length;
  if (in24h >= med.maxPer24h) (med.emergency ? warnings : blocks).push(`Daily maximum reached (${med.maxPer24h} per 24 h)`);

  const recent = history.filter((h) => now - h.ts < 24 * HOUR && h.medId !== med.id);
  for (const rule of INTERACTIONS) {
    const [a, b] = rule.classes;
    if (med.drugClass === a && recent.some((h) => h.drugClass === b)) warnings.push(rule.message);
  }
  if (med.sedationH) {
    const stacked = recent.filter((h) => h.sedationH && now - h.ts < h.sedationH * HOUR);
    if (stacked.length) warnings.push(`Additive sedation with ${stacked.map((h) => h.name).join(', ')}`);
    warnings.push(`Sedating for about ${med.sedationH} h; affects duty and EVA readiness`);
  }

  return { allowed: blocks.length === 0 && hardStops.length === 0, hardStops, blocks, warnings };
}

export function inventoryStatus(med, now) {
  const flags = [];
  if (med.expiresAt <= now) flags.push('expired');
  else if (med.expiresAt - now < 30 * 24 * HOUR) flags.push('expiring');
  if (med.qty <= 0) flags.push('out');
  else if (med.qty <= (med.emergency ? 2 : med.initialQty * 0.2)) flags.push('low');
  return flags;
}
