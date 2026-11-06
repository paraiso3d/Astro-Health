// Live checks against the configured Supabase project: npm run check:supabase
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

if (existsSync('.env')) process.loadEnvFile('.env');
const { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: pub, SUPABASE_SECRET_KEY: secret } = process.env;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, secret, options);
const anon = createClient(url, pub, options);
const TABLES = ['kv', 'vitals', 'env_readings', 'alerts', 'records', 'medications', 'bundles', 'audit'];

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed += 1;
};

for (const table of TABLES) {
  const { error } = await admin.from(table).select('*', { head: true, count: 'exact' });
  check(`secret key can read ${table}`, !error, error?.message);
  const read = await anon.from(table).select('*').limit(1);
  check(`public key can't read ${table}`, !!read.error || read.data.length === 0, read.error?.code ?? 'no rows returned');
  const write = await anon.from(table).insert({});
  check(`public key can't write ${table}`, !!write.error, write.error?.code);
}

const probe = `check-${randomUUID()}`;
const round = await admin.from('kv').upsert({ k: probe, v: { ok: true } }).select();
check('secret key can write', !round.error && round.data?.[0]?.v?.ok === true, round.error?.message);
const stranger = await anon.from('kv').select('*').eq('k', probe);
check('public key can\'t see that row', !!stranger.error || stranger.data.length === 0);
await admin.from('kv').delete().eq('k', probe);

const { data: audit } = await admin.from('audit').select('seq').limit(1);
if (audit?.length) {
  const edit = await admin.from('audit').update({ actor: 'mallory' }).eq('seq', audit[0].seq);
  check('audit log can\'t be edited, even with the secret key', !!edit.error, edit.error?.message);
  const remove = await admin.from('audit').delete().eq('seq', audit[0].seq);
  check('audit log can\'t be deleted, even with the secret key', !!remove.error, remove.error?.message);
} else {
  console.log('SKIP  audit log protection (no audit rows yet)');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
