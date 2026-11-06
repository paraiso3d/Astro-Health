// Role-based access rules. Medical data is confidential between each crew member and
// their medical team: command and operations see fitness status and never the reasons.
import { SEVERITY } from './clinical/limits.js';

export const ROLE_LABEL = Object.freeze({
  flight_surgeon: 'Flight Surgeon',
  mission_ops: 'Mission Operations',
  commander: 'Commander',
  cmo: 'Crew Medical Officer',
  astronaut: 'Astronaut',
});

const MEDICAL_TEAM = new Set(['flight_surgeon', 'cmo']);
const GROUND_ROLES = new Set(['flight_surgeon', 'mission_ops']);

export const nodeOf = (user) => (GROUND_ROLES.has(user.role) ? 'ground' : 'onboard');
export const isMedicalTeam = (user) => MEDICAL_TEAM.has(user.role);
export const canViewMedical = (user, crewId) => isMedicalTeam(user) || (crewId !== null && user.crewId === crewId);
export const canRunTraining = (user) => isMedicalTeam(user);
export const canAudit = (user) => user.role === 'flight_surgeon' || user.role === 'cmo';

export function canAcknowledge(user, alert) {
  if (isMedicalTeam(user)) return true;
  if (alert.category === 'environment' || alert.crewId === null) return true;
  if (alert.crewId === user.crewId) return true;
  return alert.severity >= SEVERITY.EMERGENCY && nodeOf(user) === 'onboard';
}

/**
 * What a given user may see of an alert: everything, a redacted notice, or nothing.
 * Everyone aboard must learn of an emergency in order to respond, but not its clinical detail.
 */
export function alertViewFor(user, alert, crewName) {
  if (alert.category === 'environment' || alert.crewId === null || canViewMedical(user, alert.crewId)) return alert;
  const opsVisible = (user.role === 'commander' || user.role === 'mission_ops') && alert.severity >= SEVERITY.WARNING;
  if (alert.severity < SEVERITY.EMERGENCY && !opsVisible) return null;
  return {
    id: alert.id,
    category: 'medical',
    crewId: alert.crewId,
    severity: alert.severity,
    title: 'Medical alert',
    message: `Medical alert for ${crewName}. Clinical details are restricted to the medical team.`,
    raisedAt: alert.raisedAt,
    status: alert.status,
    escalated: alert.escalated,
    clearedAt: alert.clearedAt,
    ackedBy: alert.ackedBy,
    redacted: true,
  };
}

export function canSeeChannel(user, channel) {
  if (channel === 'ops') return true;
  if (channel.startsWith('pmc:')) return user.role === 'flight_surgeon' || user.crewId === channel.slice(4);
  return false;
}

export function channelsFor(user, crew) {
  const channels = [{ id: 'ops', label: 'Mission operations' }];
  for (const c of crew) {
    const id = `pmc:${c.id}`;
    if (canSeeChannel(user, id)) channels.push({ id, label: `Private medical conference: ${c.name}` });
  }
  return channels;
}
