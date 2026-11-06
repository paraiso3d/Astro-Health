// Fictional crew for the simulated mission. Replace this with real flight records.
export const CREW = Object.freeze([
  { id: 'okafor', name: 'A. Okafor', role: 'Commander', age: 46, sex: 'F', bloodType: 'O+', allergies: ['penicillin'], conditions: [], kcalTarget: 2400, weightKg: 68, priorDoseMsv: 90, baseline: { hr: 60, rr: 14, spo2: 98, sys: 116, dia: 74, temp: 36.7 } },
  { id: 'tanaka', name: 'K. Tanaka', role: 'Crew Medical Officer', age: 41, sex: 'M', bloodType: 'A+', allergies: [], conditions: [], kcalTarget: 2700, weightKg: 76, priorDoseMsv: 25, baseline: { hr: 62, rr: 15, spo2: 98, sys: 120, dia: 76, temp: 36.6 } },
  { id: 'moreau', name: 'L. Moreau', role: 'Flight Engineer', age: 38, sex: 'F', bloodType: 'B-', allergies: ['sulfonamide'], conditions: ['Mild seasonal rhinitis'], kcalTarget: 2300, weightKg: 62, priorDoseMsv: 0, baseline: { hr: 58, rr: 14, spo2: 99, sys: 112, dia: 70, temp: 36.7 } },
  { id: 'silva', name: 'R. Silva', role: 'Mission Specialist', age: 44, sex: 'M', bloodType: 'AB+', allergies: ['nsaid'], conditions: ['Prior lumbar disc strain'], kcalTarget: 2800, weightKg: 81, priorDoseMsv: 40, baseline: { hr: 64, rr: 15, spo2: 98, sys: 122, dia: 78, temp: 36.6 } },
]);

export const CREW_BY_ID = Object.freeze(Object.fromEntries(CREW.map((c) => [c.id, c])));

export const USERS = Object.freeze([
  { username: 'surgeon', displayName: 'Flight Surgeon', role: 'flight_surgeon', crewId: null },
  { username: 'ops', displayName: 'Mission Operations', role: 'mission_ops', crewId: null },
  { username: 'okafor', displayName: 'A. Okafor', role: 'commander', crewId: 'okafor' },
  { username: 'tanaka', displayName: 'K. Tanaka', role: 'cmo', crewId: 'tanaka' },
  { username: 'moreau', displayName: 'L. Moreau', role: 'astronaut', crewId: 'moreau' },
  { username: 'silva', displayName: 'R. Silva', role: 'astronaut', crewId: 'silva' },
]);
