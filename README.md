# AstroHealth

Crew health monitoring system for astronauts on long-duration space missions. It tracks each crew member's vital signs, cabin environment and long-term health. It raises clinical alarms on board, keeps working when contact with Earth is delayed or lost, and gives ground-based flight surgeons a time-delayed view.

> **Not a certified medical device.** This is working software that runs on simulated data. Alarm limits, drug doses, scoring models and protocols are reference defaults. Flight surgeons must validate them, and the system must go through medical-device certification (for example IEC 62304 and ISO 14971) and flight software qualification before any operational or clinical use. The crew and mission are fictional.

## Running it

Requires [Node.js](https://nodejs.org) 22.13 or later. There is nothing to install: the system has no third-party dependencies.

```bash
npm start
```

Open <http://127.0.0.1:8787>. The first run creates one account per role, with random passwords, in `data/initial-credentials.txt`. Delete that file once the passwords are distributed.

| Username | Role | Location | Sees |
|---|---|---|---|
| `surgeon` | Flight Surgeon | Ground | All medical data, delayed by the link |
| `tanaka` | Crew Medical Officer | On board | All medical data, live |
| `okafor` | Commander | On board | Own data; fitness status only for others |
| `moreau`, `silva` | Astronaut | On board | Own data; fitness status only for others |
| `ops` | Mission Operations | Ground | Fitness status and cabin data only |

**A quick demo:** sign in as `tanaka`, open **Training**, and start *Hypoxia* on a crew member. Then watch the overview. Sign in as `surgeon` in a private window to see the same event arrive later.

```bash
npm test
```

## Core features

### 1. Real-time vital signs
- Heart rate, respiratory rate, SpO2, blood pressure and core temperature for every crew member, updated once per second
- Beat-to-beat analysis: heart rate variability (RMSSD) and rhythm screening for irregular rhythm, cardiac pause, tachycardia and bradycardia
- ECG monitor display (an illustrative trace built from rate and rhythm, labeled as such)
- Activity awareness (work, rest, sleep, exercise, EVA), with limits for each and age-based exertion limits
- Trend charts over 30 minutes to 24 hours, with hover values, personal baseline and a table view
- Wearable status: sensor quality and battery level

### 2. Clinical alarms
- Four severity levels: advisory, caution, warning, emergency
- **NEWS2 early warning score**, computed in full. It's marked invalid during and for 5 minutes after exertion, and an incomplete score is never shown as low risk
- **Personal baselines**: each person's normal range is learned per activity, and the system flags deviations even inside fixed limits. It doesn't learn while someone is ill
- **Trend detection**: warns of slow falls in SpO2 and rises in temperature before limits are crossed
- **Crew-wide correlation**: low SpO2 in two or more people points to the cabin atmosphere, fast breathing plus high CO2 points to scrubber failure, and several lost streams point to the network
- Crew-specific alarm limits, set by the flight surgeon with a recorded reason and validated

### 3. Alarm safety
- Persistence: one-sample spikes don't alarm
- Hysteresis: alarms clear only after readings stay normal
- Latching: warnings and emergencies stay until a person acknowledges them
- No automatic downgrade; a worsening alert reopens even if acknowledged
- Automatic escalation of unacknowledged warnings (60 s) and emergencies (30 s)
- Audible alarms; silencing needs a reason, leaves the alert visible, and is refused for emergencies
- Recurrence counting to expose repeating alarms
- **Sensor faults are kept apart from clinical events.** A detached sensor raises a technical alert and never clears an active clinical alarm
- Implausible readings and poor signal are rejected
- Telemetry loss alarms, escalating with time
- A display watchdog warns when the screen has stopped updating, so a frozen display can't pass for a stable patient

### 4. Cabin environment and radiation
- ppCO2, ppO2, cabin pressure, temperature, humidity and radiation dose rate, with alarms and trends
- Leak detection from the rate of pressure loss, before low limits are reached
- Cumulative radiation dose per person against the 600 mSv career limit (NASA-STD-3001), with end-of-mission projection and days to limit
- Storm shelter status, reflected in dose estimates

### 5. Long-term space health
- Daily logs: sleep, exercise, fluids, energy intake, body mass, mood, stress and vigilance test lapses
- Fatigue risk from 3-day sleep debt and vigilance lapses
- Exercise countermeasure adherence, with an estimated bone loss model (labeled illustrative) that prompts a scan
- Nutrition, hydration (renal stone risk) and body mass loss alerts
- Behavioral health: flags declining mood and sustained stress
- Eye exam records and SANS screening (Frisén grade, near acuity, eye pressure)

### 6. Fit-for-duty and EVA go/no-go
- GO, RESTRICTED, NO-GO or UNKNOWN for duty and for EVA, each with reasons
- Draws on alarms, NEWS2, symptoms, sedating drugs, sleep, radiation, eye exams and cabin alarms
- **Fails safe:** missing data gives UNKNOWN, never GO
- Medical hold, set by the medical team

### 7. Symptoms and clinical record
- Symptom reporting with automatic triage. Red-flag symptoms, such as chest pain, are always emergencies
- Each symptom raises an alert linked to its protocol
- Clinical notes, consciousness (AVPU) and oxygen checks
- Allergies, conditions, blood type and baseline values for each crew member

### 8. Pharmacy
- Inventory with quantity, expiry, and low-stock and expiry warnings
- Safety check before every dose: allergy (including whole drug classes), cross-reactivity, expiry, minimum interval, daily maximum, interactions, sedation stacking
- Blocks need a CMO override with a recorded reason; out of stock can't be overridden
- Emergency drugs such as epinephrine only warn and are never withheld, and any crew member can give them
- Medication record; sedating doses feed readiness automatically

### 9. Onboard emergency protocols
- 17 response cards for use when Earth is too far away to help in real time, including cardiac arrest, hypoxia, depressurization, toxic atmosphere, anaphylaxis, decompression sickness, solar particle events and behavioral health
- Alarms and symptoms link directly to the relevant card

### 10. Earth-space communication
- **Models real light-time delay**, with presets from low Earth orbit (0.25 s) to Mars at its farthest (22.3 min)
- The crew always gets alerts instantly on board. The ground view is delayed, and shows how old its data is
- Store-and-forward during loss of signal, in priority order: emergencies, alerts, messages, telemetry
- Only the oldest telemetry is ever discarded when storage is full; alerts and messages never are
- Ground commands (acknowledge, hold, limits) take effect only after the uplink delay, and show as pending until then
- Queued alerts, messages and commands survive a restart
- Secure messaging, with urgent priority
- **Private Medical Conference** channels between one astronaut and the flight surgeon, closed even to the CMO

### 11. Privacy and security
- Five roles, enforced on the server for every request
- Command and operations see fitness status only, with reasons withheld. In an emergency, everyone aboard is alerted without clinical details
- Salted scrypt password hashing, login lockout, HttpOnly SameSite=Strict session cookies with 12-hour expiry
- Content Security Policy, input validation, request size limits, path traversal protection, parameter whitelists
- Separate token authentication for devices
- **Tamper-evident audit log**: a SHA-256 hash chain covering logins, record access, acknowledgements, doses, overrides, exports and configuration changes, with one-click verification

### 12. Reports and data
- Printable medical summary per crew member: readiness, 24-hour vital statistics, findings, alerts, medications and symptoms
- CSV export of vitals (24 hours or 7 days), audited
- Alert history
- SQLite storage that survives restarts (alerts, dose, holds, limits, records), with 90-day telemetry retention

### 13. Training and integration
- Physiology and cabin simulator with 12 failure scenarios: hypoxia, tachyarrhythmia, cardiac pause, hypotension, fever, EVA heat stress, sensor dropout, telemetry loss, solar particle event, CO2 scrubber failure, cabin leak, thermal failure
- Controls for link delay and loss of signal
- All simulated data is clearly labeled on screen
- **Real device integration:** `POST /api/ingest` feeds real wearables and life-support sensors through the same clinical pipeline

## Connecting real devices

```bash
DATA_SOURCE=ingest INGEST_TOKEN=your-long-random-token npm start
```

On Windows PowerShell, set `$env:DATA_SOURCE` and `$env:INGEST_TOKEN` first. Devices then send readings at about 1 Hz:

```
POST /api/ingest
Authorization: Bearer your-long-random-token
Content-Type: application/json

{
  "samples": [{
    "crewId": "moreau", "activity": "rest",
    "hr": 62, "rr": 14, "spo2": 98, "sys": 115, "dia": 72, "temp": 36.7,
    "quality": { "ecg": 1, "resp": 1, "pulseox": 1, "bp": 1, "temp": 1 },
    "intervals": [960, 972, 955], "battery": 80
  }],
  "env": { "co2": 2.2, "o2": 21.2, "pressure": 101.3, "cabinTemp": 22.5, "humidity": 45, "radiation": 75 }
}
```

`quality` runs from 0 to 1 per sensor. A missing quality value counts as 0, so that reading is treated as unreliable.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on |
| `DATA_DIR` | `./data` | Database and credentials location |
| `DATA_SOURCE` | `simulator` | `simulator` or `ingest` |
| `INGEST_TOKEN` | none | Device token, required for `ingest` |

## Project layout

```
src/
  clinical/      NEWS2, limits, alarm engine, evaluators, signal analytics,
                 long-term health, readiness, triage, pharmacy, protocols
  system.js      Orchestrator: main loop, spacecraft and ground views, all actions
  link.js        Delay-tolerant space-ground link
  simulator.js   Physiology and cabin simulator, failure scenarios
  store.js       SQLite storage and tamper-evident audit log
  access.js      Role and confidentiality rules
  auth.js        Passwords, sessions, lockout
  server.js      HTTP API, live stream, static files
  crew.js        Fictional crew and accounts (replace with real records)
public/          Console UI (no build step)
test/            Clinical, system and HTTP test suites
```

## Known limitations

Before real use, these need to be addressed:

- **Certification and clinical validation** have not been done. See the notice at the top.
- **Spacecraft and ground share one process and database here,** to model the link. A flight deployment would run separate nodes with real replication, and a real delay-tolerant networking stack in place of the modeled link.
- **Single server:** there is no redundancy or failover, which flight hardware would need.
- **HTTP only:** put it behind TLS before exposing it beyond the local machine, and add the `Secure` cookie flag. Data is not encrypted at rest.
- **Audit log:** the hash chain reveals tampering, but someone with full database access could rewrite the entire chain. Anchoring the latest hash on the ground would close that gap.
- **Rhythm analysis** is beat-interval screening only, not diagnostic ECG interpretation.
- **Dose per person** is estimated from one cabin reading. Personal dosimeters remain the record.
- **Account management:** accounts are created on first run, and there is no screen yet for changing passwords or managing users.
- **Alarm content:** NEWS2 is validated for hospital patients, not for microgravity or fit astronauts, so treat it as a screening aid.
