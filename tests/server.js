// Local stand-in for Supabase: in-memory Postgres (PGlite) behind a tiny PostgREST-style /rest/v1/rpc endpoint,
// plus the real api/quiz.js handler and the static index.html, all on one port.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const REPO = path.resolve(__dirname, '..');

async function boot(port = 8787) {
  const db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`);
  await db.exec(fs.readFileSync(path.join(REPO, 'supabase/schema.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(REPO, 'supabase/seed.sql'), 'utf8'));
  process.env.SUPABASE_URL = 'http://127.0.0.1:' + port;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.HASH_PEPPER = 'test-pepper-0123456789';
  delete require.cache[require.resolve(path.join(REPO, 'api/quiz.js'))];
  const handler = require(path.join(REPO, 'api/quiz.js'));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = ''; for await (const c of req) raw += c;
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      if (req.headers.apikey !== 'test-service-key') { res.writeHead(401); return res.end('{"message":"bad key"}'); }
      const fn = url.pathname.split('/').pop(), args = JSON.parse(raw || '{}'), keys = Object.keys(args);
      try {
        const q = `select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
        const r = await db.query(q, keys.map(k => args[k]));
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r.rows[0].r));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: e.code || 'P0001', message: e.message })); }
    }
    if (url.pathname === '/api/quiz') {
      let body; try { body = JSON.parse(raw); } catch (e) { body = raw; }
      req.body = req.method === 'POST' ? body : undefined;
      res.status = c => { res.statusCode = c; return res; };
      res.json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      return handler(req, res);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(REPO, 'index.html'))); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(port, r));
  return { db, server, port };
}
module.exports = { boot };
if (require.main === module) boot().then(() => console.log('listening on 8787'));
