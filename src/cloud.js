import { appendFileSync, chmodSync, writeFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { generatePassword } from './auth.js';
import { USERS } from './crew.js';

const PRIMARY_KEYS = { kv: 'k', vitals: 'crew_id,ts', env_readings: 'ts', alerts: 'id', records: 'id', medications: 'id', bundles: 'id', audit: 'seq' };
const BATCH = 500;
const PAGE = 1000;
const CLOUD_RETENTION_DAYS = 30;
const EMAIL_DOMAIN = 'astrohealth.example';

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export const createAdminClient = (url, secretKey) => createClient(url, secretKey, clientOptions);

const keyOf = (table, row) => PRIMARY_KEYS[table].split(',').map((c) => row[c]).join('|');

/**
 * Sends queued local changes to Supabase, in order. The alarm loop never waits on this,
 * and a change leaves the queue only after Supabase has confirmed it, so an outage only
 * delays data. Failed batches simply retry on the next flush.
 */
export class SupabaseSync {
  constructor({ store, client, clock = Date.now }) {
    this.store = store;
    this.client = client;
    this.clock = clock;
    this.flushing = null;
    this.lastSyncAt = null;
    this.lastError = null;
    this.lastPruneAt = 0;
  }

  async #sendGroup(table, op, rows) {
    if (op === 'delete') {
      const { error } = await this.client.from(table).delete().in(PRIMARY_KEYS[table], rows.map((r) => r[PRIMARY_KEYS[table]]));
      if (error) throw new Error(`${table}: ${error.message}`);
      return;
    }
    // One upsert can't touch the same row twice, so keep only the latest change to each
    const latest = new Map(rows.map((r) => [keyOf(table, r), r]));
    const options = { onConflict: PRIMARY_KEYS[table], ignoreDuplicates: table === 'audit' };
    const { error } = await this.client.from(table).upsert([...latest.values()], options);
    if (error) throw new Error(`${table}: ${error.message}`);
  }

  async #drain() {
    for (;;) {
      const ops = this.store.outboxRows(BATCH);
      if (!ops.length) return;
      let i = 0;
      while (i < ops.length) {
        let j = i;
        while (j + 1 < ops.length && ops[j + 1].tbl === ops[i].tbl && ops[j + 1].op === ops[i].op) j += 1;
        await this.#sendGroup(ops[i].tbl, ops[i].op, ops.slice(i, j + 1).map((o) => o.row));
        this.store.outboxDeleteThrough(ops[j].seq);
        i = j + 1;
      }
    }
  }

  /** Safe to call at any time; overlapping calls share one pass, preserving order. */
  flush() {
    this.flushing ??= this.#drain()
      .then(async () => {
        const now = this.clock();
        this.lastSyncAt = now;
        this.lastError = null;
        if (now - this.lastPruneAt >= 3600000) {
          this.lastPruneAt = now;
          await this.#prune(now);
        }
      })
      .catch((err) => {
        this.lastError = err.message;
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  async #prune(now) {
    const cutoff = now - CLOUD_RETENTION_DAYS * 86400000;
    for (const table of ['vitals', 'env_readings']) {
      const { error } = await this.client.from(table).delete().lt('ts', cutoff);
      if (error) throw new Error(`${table}: ${error.message}`);
    }
  }

  status() {
    return { pending: this.store.outboxCount(), lastSyncAt: this.lastSyncAt, error: this.lastError };
  }
}

async function readAll(client, table, orderColumn) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from(table).select('*').order(orderColumn).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

/** Rebuilds an empty local copy from Supabase, for a new machine or a lost disk. */
export async function hydrateFromCloud(store, client) {
  if (store.kvGet('mission')) return false;
  const { data, error } = await client.from('kv').select('k').eq('k', 'mission').maybeSingle();
  if (error) throw new Error(`Can't read Supabase: ${error.message}`);
  if (!data) return false;
  const tables = {};
  for (const [table, order] of [['kv', 'k'], ['alerts', 'id'], ['records', 'id'], ['medications', 'id'], ['bundles', 'id'], ['audit', 'seq'], ['vitals', 'ts'], ['env_readings', 'ts']]) {
    tables[table] = await readAll(client, table, order);
  }
  store.importFromCloud(tables);
  return true;
}

const emailFor = (username) => `${username}@${EMAIL_DOMAIN}`;

/** Supabase Auth checks passwords. Roles live in app_metadata, which users can't edit themselves. */
export class SupabaseDirectory {
  constructor({ url, publishableKey, adminClient }) {
    this.url = url;
    this.publishableKey = publishableKey;
    this.admin = adminClient;
  }

  async authenticate(username, password) {
    if (!/^[\w.-]{1,64}$/.test(username)) return null;
    const client = createClient(this.url, this.publishableKey, clientOptions);
    const { data, error } = await client.auth.signInWithPassword({ email: emailFor(username), password });
    if (error) {
      if (error.status === 400 || error.code === 'invalid_credentials') return null;
      throw new Error(`Supabase Auth: ${error.message}`);
    }
    const meta = data.user.app_metadata ?? {};
    if (!meta.role) return null;
    return { username: meta.username, displayName: meta.displayName, role: meta.role, crewId: meta.crewId ?? null };
  }

  /** Creates any missing accounts with random passwords, written to a private local file. */
  async ensureUsers(credentialsFile) {
    const { data, error } = await this.admin.auth.admin.listUsers({ perPage: 200 });
    if (error) throw new Error(`Supabase Auth: ${error.message}`);
    const existing = new Set(data.users.map((u) => u.email));
    const created = [];
    for (const u of USERS) {
      if (existing.has(emailFor(u.username))) continue;
      const password = generatePassword();
      const { error: createError } = await this.admin.auth.admin.createUser({
        email: emailFor(u.username),
        password,
        email_confirm: true,
        app_metadata: { username: u.username, displayName: u.displayName, role: u.role, crewId: u.crewId },
      });
      if (createError) throw new Error(`Supabase Auth: ${createError.message}`);
      created.push(`${u.username.padEnd(10)} ${password}   (${u.role})`);
    }
    if (created.length) {
      if (!existsSync(credentialsFile)) writeFileSync(credentialsFile, '# AstroHealth initial credentials. Delete this file once they are distributed.\n\n', { mode: 0o600 });
      appendFileSync(credentialsFile, `${created.join('\n')}\n`);
      chmodSync(credentialsFile, 0o600);
    }
    return created.length;
  }
}
