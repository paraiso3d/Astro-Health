import { randomUUID } from 'node:crypto';

export const PRIORITY = Object.freeze({ EMERGENCY: 0, ALERT: 1, MESSAGE: 2, TELEMETRY: 3 });

export const LINK_PRESETS = Object.freeze({
  demo: { label: 'Demo (15 s)', delaySec: 15 },
  leo: { label: 'Low Earth orbit (0.25 s)', delaySec: 0.25 },
  lunar: { label: 'Lunar (1.3 s)', delaySec: 1.3 },
  'mars-near': { label: 'Mars closest (3.1 min)', delaySec: 186 },
  'mars-far': { label: 'Mars farthest (22.3 min)', delaySec: 1338 },
});

/**
 * Delay-tolerant store-and-forward link between the spacecraft and the ground.
 * During loss of signal, bundles wait in priority order; those already in flight still
 * arrive. Queues are bounded by shedding only the oldest telemetry, never alerts or messages.
 */
export class DtnLink {
  constructor({ delaySec = 15, ratePerTick = 6, telemetryCapacity = 3600, onPersist = () => {}, onDelivered = () => {} } = {}) {
    this.delaySec = delaySec;
    this.ratePerTick = ratePerTick;
    this.telemetryCapacity = telemetryCapacity;
    this.los = false;
    this.onPersist = onPersist;
    this.onDelivered = onDelivered;
    this.queues = { down: [], up: [] };
    this.inFlight = { down: [], up: [] };
    this.stats = { sent: 0, delivered: 0, shed: 0 };
  }

  /** Restores unsent custody bundles after a restart. */
  restore(bundles) {
    for (const bundle of bundles) this.#enqueue(bundle);
  }

  send(direction, type, payload, priority, now) {
    const bundle = { id: randomUUID(), direction, type, payload, priority, createdAt: now };
    this.stats.sent += 1;
    if (priority !== PRIORITY.TELEMETRY) this.onPersist(bundle);
    this.#enqueue(bundle);
    if (priority === PRIORITY.TELEMETRY) this.#shedTelemetry(direction);
    return bundle;
  }

  #enqueue(bundle) {
    const queue = this.queues[bundle.direction];
    let i = queue.length;
    while (i > 0 && queue[i - 1].priority > bundle.priority) i--;
    queue.splice(i, 0, bundle);
  }

  #shedTelemetry(direction) {
    const queue = this.queues[direction];
    const telemetry = queue.filter((b) => b.priority === PRIORITY.TELEMETRY).length;
    if (telemetry > this.telemetryCapacity) {
      queue.splice(queue.findIndex((b) => b.priority === PRIORITY.TELEMETRY), 1);
      this.stats.shed += 1;
    }
  }

  /** Moves queued bundles into flight, and returns bundles that have arrived, in order. */
  tick(now) {
    const delivered = [];
    for (const direction of ['down', 'up']) {
      if (!this.los) {
        const batch = this.queues[direction].splice(0, this.ratePerTick);
        for (const bundle of batch) this.inFlight[direction].push({ bundle, arrivesAt: now + this.delaySec * 1000 });
      }
      const flight = this.inFlight[direction];
      flight.sort((a, b) => a.arrivesAt - b.arrivesAt);
      while (flight.length && flight[0].arrivesAt <= now) {
        const { bundle } = flight.shift();
        delivered.push(bundle);
        this.stats.delivered += 1;
        if (bundle.priority !== PRIORITY.TELEMETRY) this.onDelivered(bundle);
      }
    }
    return delivered;
  }

  status() {
    return {
      delaySec: this.delaySec,
      los: this.los,
      queuedDown: this.queues.down.length,
      queuedUp: this.queues.up.length,
      inFlightDown: this.inFlight.down.length,
      inFlightUp: this.inFlight.up.length,
      ...this.stats,
    };
  }
}
