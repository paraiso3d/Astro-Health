import { randomBytes } from 'node:crypto';

const SESSION_MS = 12 * 3600000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60000;

export const generatePassword = () => randomBytes(12).toString('base64url');

/** Sessions and lockout. The directory (Supabase Auth in production) checks the password. */
export class Auth {
  constructor(store, directory, clock = Date.now) {
    this.store = store;
    this.directory = directory;
    this.clock = clock;
    this.sessions = new Map();
    this.failures = new Map();
  }

  /** Returns { token, user } on success; { error, status } otherwise. */
  async login(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || username.length > 64 || password.length > 256) {
      return { status: 400, error: 'username and password are required' };
    }
    const started = this.clock();
    const failure = this.failures.get(username);
    if (failure && failure.count >= MAX_FAILURES && started - failure.at < LOCKOUT_MS) {
      return { status: 429, error: 'too many failed attempts; try again in a few minutes' };
    }
    let user;
    try {
      user = await this.directory.authenticate(username, password);
    } catch (err) {
      console.error('sign-in service error:', err.message);
      return { status: 503, error: 'the sign-in service is unavailable; try again shortly' };
    }
    const now = this.clock();
    if (!user) {
      const count = failure && now - failure.at < LOCKOUT_MS ? failure.count + 1 : 1;
      this.failures.set(username, { count, at: now });
      this.store.audit({ ts: now, actor: username, action: 'login.failed' });
      return { status: 401, error: 'wrong username or password' };
    }
    this.failures.delete(username);
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
