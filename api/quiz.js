'use strict';
/*
 * The only door to the database. The browser posts { action, ... } here; this function checks the input,
 * hashes the player's device secret and the caller's address, and calls one Postgres stored procedure through
 * Supabase's REST interface with the service-role key. The key never leaves the server.
 *
 * Environment variables (set them in Vercel, see README):
 *   SUPABASE_URL                e.g. https://abcdxyz.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   the Secret key (sb_secret_...) or the legacy service_role key; server only,
 *                               never expose it in the page
 *   HASH_PEPPER                 a long random string; used when hashing secrets and addresses
 */
const crypto = require('crypto');

const HANDLE = /^[A-Za-z0-9 _.-]{2,16}$/;
const SECRET = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS = {
  invalid_input: 400, forbidden: 403, handle_taken: 409, out_of_order: 409, already_answered: 409,
  already_finished: 409, incomplete: 409, rate_limited: 429, not_seeded: 503
};
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

async function rpc(fn, args) {
  const base = process.env.SUPABASE_URL.replace(/\/+$/, ''), key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // New-style secret keys (sb_secret_...) are not JWTs and go in the apikey header only.
  // Legacy service_role keys are JWTs (they start with "eyJ") and also go in the Authorization header.
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  const r = await fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!r.ok) {
    const code = json && typeof json.message === 'string' && STATUS[json.message] ? json.message : null;
    const err = new Error(code || 'upstream_error');
    err.code = code; err.detail = r.status + ' ' + text.slice(0, 300);
    err.upstreamStatus = r.status; err.upstreamCode = json && typeof json.code === 'string' ? json.code : null;
    throw err;
  }
  return json;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) { for await (const chunk of req) { raw += chunk; if (raw.length > 20000) break; } }
  try { return JSON.parse(raw); } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.HASH_PEPPER) {
    return res.status(500).json({ error: 'server_not_configured' });
  }
  const b = await readBody(req);
  if (!b || typeof b !== 'object') return res.status(400).json({ error: 'invalid_input' });

  const pepper = process.env.HASH_PEPPER;
  const secretHash = typeof b.secret === 'string' && SECRET.test(b.secret) ? sha(pepper + '|secret|' + b.secret) : null;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
  const ipHash = sha(pepper + '|ip|' + ip);

  try {
    let out;
    switch (b.action) {
      case 'start':
        if (!secretHash || typeof b.handle !== 'string' || !HANDLE.test(b.handle)) return res.status(400).json({ error: 'invalid_input' });
        out = await rpc('start_run', { p_handle: b.handle, p_secret_hash: secretHash, p_ip_hash: ipHash });
        break;
      case 'answer':
        if (!secretHash || !UUID.test(String(b.run_id)) || !Number.isInteger(b.question) || b.question < 1 || b.question > 100 ||
            !Number.isInteger(b.choice) || b.choice < 0 || b.choice > 3) return res.status(400).json({ error: 'invalid_input' });
        out = await rpc('answer_question', { p_run: b.run_id, p_secret_hash: secretHash, p_question: b.question, p_choice: b.choice });
        break;
      case 'finish':
        if (!secretHash || !UUID.test(String(b.run_id))) return res.status(400).json({ error: 'invalid_input' });
        out = await rpc('finish_run', { p_run: b.run_id, p_secret_hash: secretHash });
        break;
      case 'board': {
        const limit = Number.isInteger(b.limit) ? Math.min(Math.max(b.limit, 1), 100) : 50;
        out = { rows: await rpc('get_board', { p_limit: limit, p_secret_hash: secretHash || '' }) };
        break;
      }
      default:
        return res.status(400).json({ error: 'invalid_input' });
    }
    return res.status(200).json(out);
  } catch (e) {
    if (e.code) return res.status(STATUS[e.code]).json({ error: e.code });
    console.error('quiz api error:', e.message, e.detail || '');
    // Only a status number and an error code (for example PGRST202 or ENOTFOUND), never a message, key or URL:
    // enough to tell a missing function from a wrong URL or key without opening the Vercel logs.
    return res.status(502).json({ error: 'server_error', upstream_status: e.upstreamStatus || null, upstream_code: e.upstreamCode || (e.cause && e.cause.code) || e.name || null });
  }
};
