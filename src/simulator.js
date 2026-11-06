// Physiological and cabin simulator for training and demonstration. It stands in for
// real wearables and life-support sensors; POST /api/ingest takes real data instead.

export const SCENARIOS = Object.freeze({
  hypoxia: { label: 'Hypoxia', scope: 'crew', description: 'SpO2 falls toward 84% with a compensating rise in heart and breathing rate.' },
  arrhythmia: { label: 'Tachyarrhythmia', scope: 'crew', description: 'Irregular rhythm near 165 bpm with falling blood pressure.' },
  'cardiac-pause': { label: 'Cardiac pause', scope: 'crew', description: 'Beat intervals over 3 s at slow heart rate.' },
  syncope: { label: 'Hypotension', scope: 'crew', description: 'Blood pressure falls to 78/48 with slow heart rate.' },
  fever: { label: 'Fever / sepsis', scope: 'crew', description: 'Temperature toward 39.4 °C with raised heart and breathing rate.' },
  'heat-stress': { label: 'EVA heat stress', scope: 'crew', description: 'Crew member on EVA; core temperature toward 39.7 °C.' },
  'sensor-dropout': { label: 'Sensor dropout', scope: 'crew', description: 'ECG and pulse oximeter lose contact. Tests fault handling.' },
  'data-loss': { label: 'Telemetry loss', scope: 'crew', description: 'The wearable stops transmitting altogether.' },
  spe: { label: 'Solar particle event', scope: 'cabin', description: 'Dose rate climbs to about 3,000 µSv/h.' },
  co2: { label: 'CO2 scrubber failure', scope: 'cabin', description: 'ppCO2 climbs to 9 mmHg; all crew breathe faster.' },
  depress: { label: 'Cabin leak', scope: 'cabin', description: 'Pressure falls at 0.6 kPa/min with falling ppO2 and crew SpO2.' },
  'cabin-heat': { label: 'Thermal control failure', scope: 'cabin', description: 'Cabin temperature climbs to 31 °C.' },
});

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHEDULE = [['work', 600], ['exercise', 240], ['rest', 360], ['sleep', 600]];
const CYCLE_S = SCHEDULE.reduce((sum, [, s]) => sum + s, 0);
const PARAMS = ['hr', 'rr', 'spo2', 'sys', 'dia', 'temp'];
const TAU_S = { hr: 30, rr: 20, spo2: 20, sys: 40, dia: 40, temp: 120 };
const NOISE = { hr: 0.8, rr: 0.3, spo2: 0.15, sys: 0.8, dia: 0.6, temp: 0.01 };
const ROUND = { hr: 1, rr: 1, spo2: 1, sys: 1, dia: 1, temp: 100 };

function activityAt(now, index) {
  let t = (Math.floor(now / 1000) + index * 450) % CYCLE_S;
  for (const [activity, seconds] of SCHEDULE) {
    if (t < seconds) return activity;
    t -= seconds;
  }
  return 'work';
}

function targetsFor(crew, activity) {
  const b = crew.baseline;
  const max = 220 - crew.age;
  switch (activity) {
    case 'work': return { hr: b.hr + 10, rr: b.rr + 2, spo2: b.spo2, sys: b.sys + 6, dia: b.dia + 3, temp: b.temp + 0.1 };
    case 'exercise': return { hr: max * 0.72, rr: 28, spo2: b.spo2 - 1, sys: b.sys + 40, dia: b.dia + 4, temp: b.temp + 0.6 };
    case 'eva': return { hr: max * 0.62, rr: 22, spo2: b.spo2, sys: b.sys + 20, dia: b.dia + 4, temp: b.temp + 0.4 };
    case 'sleep': return { hr: b.hr - 8, rr: b.rr - 2, spo2: b.spo2, sys: b.sys - 10, dia: b.dia - 6, temp: b.temp - 0.3 };
    default: return { ...b };
  }
}

const towards = (t, r, values) => {
  for (const [k, v] of Object.entries(values)) t[k] += (v - t[k]) * r;
};
const add = (t, r, values) => {
  for (const [k, v] of Object.entries(values)) t[k] += v * r;
};

export class Simulator {
  constructor(crew, seed = 1) {
    this.crew = crew;
    this.random = mulberry32(seed);
    this.scenarios = new Map();
    this.state = new Map(crew.map((c, i) => [c.id, { index: i, ...targetsFor(c, 'rest'), battery: 90, noise: {} }]));
    this.env = { co2: 2.2, o2: 21.2, pressure: 101.3, cabinTemp: 22.5, humidity: 45, radiation: 75 };
  }

  gauss() {
    return Math.sqrt(-2 * Math.log(this.random() || 1e-9)) * Math.cos(2 * Math.PI * this.random());
  }

  start(type, crewId, now) {
    const meta = SCENARIOS[type];
    if (!meta) throw new RangeError(`unknown scenario: ${type}`);
    const id = meta.scope === 'crew' ? `${type}:${crewId}` : type;
    const scenario = { id, type, crewId: meta.scope === 'crew' ? crewId : null, startedAt: now };
    this.scenarios.set(id, scenario);
    return scenario;
  }

  stop(id) {
    return this.scenarios.delete(id);
  }

  list() {
    return [...this.scenarios.values()];
  }

  #active(type, crewId) {
    return this.scenarios.get(crewId ? `${type}:${crewId}` : type) ?? null;
  }

  #ramp(scenario, now, tauS) {
    return scenario ? 1 - Math.exp(-(now - scenario.startedAt) / 1000 / tauS) : 0;
  }

  #stepEnv(now, dt) {
    const e = this.env;
    const targets = { co2: 2.2, o2: 21.2, cabinTemp: 22.5, humidity: 45, radiation: 75 };
    const co2 = this.#active('co2');
    if (co2) targets.co2 = 2.2 + (9 - 2.2) * this.#ramp(co2, now, 60);
    const spe = this.#active('spe');
    if (spe) targets.radiation = 75 + 2925 * this.#ramp(spe, now, 60);
    const heat = this.#active('cabin-heat');
    if (heat) targets.cabinTemp = 22.5 + 8.5 * this.#ramp(heat, now, 90);
    if (this.#active('depress')) {
      e.pressure = Math.max(55, e.pressure - (0.6 * dt) / 60);
    } else {
      e.pressure += (101.3 - e.pressure) * Math.min(1, dt / 30);
    }
    targets.o2 = 21.2 * (e.pressure / 101.3);
    for (const k of Object.keys(targets)) e[k] += (targets[k] - e[k]) * Math.min(1, dt / 15);
    return {
      ts: now,
      co2: e.co2 + this.gauss() * 0.03,
      o2: e.o2 + this.gauss() * 0.03,
      pressure: e.pressure + this.gauss() * 0.01,
      cabinTemp: e.cabinTemp + this.gauss() * 0.03,
      humidity: e.humidity + this.gauss() * 0.2,
      radiation: Math.max(0, e.radiation + this.gauss() * 4),
    };
  }

  #stepCrew(crew, now, dt) {
    const s = this.state.get(crew.id);
    const id = crew.id;
    const hypoxia = this.#active('hypoxia', id);
    const arrhythmia = this.#active('arrhythmia', id);
    const pause = this.#active('cardiac-pause', id);
    const syncope = this.#active('syncope', id);
    const fever = this.#active('fever', id);
    const heatStress = this.#active('heat-stress', id);
    const dropout = this.#active('sensor-dropout', id);

    if (this.#active('data-loss', id)) return null;

    const activity = heatStress ? 'eva' : activityAt(now, s.index);
    const t = targetsFor(crew, activity);
    if (hypoxia) {
      const r = this.#ramp(hypoxia, now, 60);
      towards(t, r, { spo2: 84 });
      add(t, r, { hr: 28, rr: 10 });
    }
    if (arrhythmia) {
      const r = this.#ramp(arrhythmia, now, 15);
      towards(t, r, { hr: 165 });
      add(t, r, { sys: -25, dia: -10 });
    }
    if (pause) towards(t, this.#ramp(pause, now, 10), { hr: 42 });
    if (syncope) towards(t, this.#ramp(syncope, now, 30), { sys: 78, dia: 48, hr: 44 });
    if (fever) {
      const r = this.#ramp(fever, now, 90);
      towards(t, r, { temp: 39.4 });
      add(t, r, { hr: 28, rr: 8, sys: -10 });
    }
    if (heatStress) {
      const r = this.#ramp(heatStress, now, 90);
      towards(t, r, { temp: 39.7, hr: 168 });
      add(t, r, { rr: 10 });
    }
    const co2 = this.#active('co2');
    if (co2) add(t, this.#ramp(co2, now, 90), { rr: 10, hr: 10 });
    if (this.#active('depress')) t.spo2 -= Math.max(0, 21.2 - this.env.o2) * 3.5;
    const cabinHeat = this.#active('cabin-heat');
    if (cabinHeat) add(t, this.#ramp(cabinHeat, now, 180), { temp: 0.5, hr: 6 });

    const sample = { ts: now, crewId: id, activity, quality: {}, source: 'simulator' };
    for (const p of PARAMS) {
      s[p] += (t[p] - s[p]) * Math.min(1, dt / TAU_S[p]);
      s.noise[p] = 0.7 * (s.noise[p] ?? 0) + this.gauss() * NOISE[p] * 0.7;
      sample[p] = Math.round((s[p] + s.noise[p]) * ROUND[p]) / ROUND[p];
    }
    sample.spo2 = Math.min(100, sample.spo2);

    for (const sensor of ['ecg', 'resp', 'pulseox', 'bp', 'temp']) sample.quality[sensor] = 0.9 + this.random() * 0.1;

    // Rare, short motion artifact on the pulse oximeter
    if (this.random() < 0.002) {
      sample.spo2 = Math.round(70 + this.random() * 15);
      sample.quality.pulseox = 0.25;
    }

    const beats = Math.max(1, Math.round((sample.hr / 60) * dt));
    sample.intervals = [];
    const jitter = arrhythmia ? 0.25 : 0.025;
    for (let i = 0; i < beats; i++) sample.intervals.push(Math.max(250, (60000 / sample.hr) * (1 + this.gauss() * jitter)));
    if (pause && now - pause.startedAt > 15000 && this.random() < 0.03) sample.intervals[0] = 3500;

    if (dropout) {
      sample.hr = null;
      sample.spo2 = null;
      sample.intervals = [];
      sample.quality.ecg = 0;
      sample.quality.pulseox = 0;
    }

    s.battery = activity === 'sleep' ? Math.min(100, s.battery + 0.2 * dt) : Math.max(0, s.battery - 0.02 * dt);
    sample.battery = Math.round(s.battery);
    return sample;
  }

  step(now, dt = 1) {
    const env = this.#stepEnv(now, dt);
    const samples = this.crew.map((c) => this.#stepCrew(c, now, dt)).filter(Boolean);
    return { env, samples };
  }
}

/** Deterministic daily logs for elapsed mission days, so long-term views have history. */
export function generateDailyLog(crew, day, totalDays, random) {
  const noise = (sd) => (random() + random() + random() - 1.5) * sd * 1.15;
  const recent = day > totalDays - 7;
  const strained = crew.id === 'silva' && recent;
  return {
    missionDay: day,
    sleepH: Math.round((strained ? 5.4 + noise(0.2) : 7.1 + noise(0.5)) * 10) / 10,
    exerciseMin: Math.round(strained ? 95 + noise(10) : 125 + noise(12)),
    waterL: Math.round((crew.id === 'moreau' && recent ? 1.7 + noise(0.15) : 2.6 + noise(0.25)) * 10) / 10,
    kcal: Math.round(crew.kcalTarget * (0.98 + noise(0.05))),
    mood: Math.round((strained ? 5.5 + noise(0.5) : 7.6 + noise(0.5)) * 10) / 10,
    stress: Math.round((strained ? 6.2 + noise(0.5) : 3.8 + noise(0.6)) * 10) / 10,
    pvtLapses: Math.max(0, Math.round((strained ? 3 : 1) + noise(0.7))),
    weightKg: Math.round((crew.weightKg - day * 0.025 + noise(0.2)) * 10) / 10,
  };
}
