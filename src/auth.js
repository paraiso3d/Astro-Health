import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_MS = 12 * 3600000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60000;
const DUMMY_SALT = randomBytes(16).toString('hex');

const hash = (password, salt) => scryptSync(password, salt, 64).toString('hex');

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: hash(password, salt) };
}

export const generatePassword = () => randomBytes(12).toString('base64url');

export class Auth {
  constructor(store, clock = Date.now) {
    this.store = store;
    this.clock = clock;
    this.sessions = new Map();
    this.failures = new Map();
  }

  /** Returns { token, user } on success; { error, status } otherwise. */
  login(username, password) {
    const now = this.clock();
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 256) {
      return { status: 400, error: 'username and password are required' };
    }
    const failure = this.failures.get(username);
    if (failure && failure.count >= MAX_FAILURES && now - failure.at < LOCKOUT_MS) {
      return { status: 429, error: 'too many failed attempts; try again in a few minutes' };
    }
    const row = this.store.getUser(username);
    // Unknown users still pay for a hash, so response time doesn't reveal which names exist
    const actual = Buffer.from(hash(password, row?.salt ?? DUMMY_SALT), 'hex');
    const expected = row ? Buffer.from(row.hash, 'hex') : randomBytes(64);
    if (!timingSafeEqual(actual, expected) || !row) {
      const count = failure && now - failure.at < LOCKOUT_MS ? failure.count + 1 : 1;
      this.failures.set(username, { count, at: now });
      this.store.audit({ ts: now, actor: username, action: 'login.failed' });
      return { status: 401, error: 'wrong username or password' };
    }
    this.failures.delete(username);
    const user = { username: row.username, displayName: row.display_name, role: row.role, crewId: row.crew_id };
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { user, expiresAt: now + SESSION_MS });
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'login' });
    return { token, user };
  }

  logout(token) {
    const session = this.sessions.get(token);
    if (session) {
      this.store.audit({ ts: this.clock(), actor: session.user.username, role: session.user.role, action: 'logout' });
      this.sessions.delete(token);
    }
  }

  userFor(token) {
    const session = token ? this.sessions.get(token) : null;
    if (!session) return null;
    if (session.expiresAt <= this.clock()) {
      this.sessions.delete(token);
      return null;
    }
    return session.user;
  }
}
