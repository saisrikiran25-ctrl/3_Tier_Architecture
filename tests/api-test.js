const { boot } = require('./server.js');
const crypto = require('crypto');
const hex = () => crypto.randomBytes(32).toString('hex');
let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(extra))); if (!cond) fails++; };

(async () => {
  const { db, server, port } = await boot(8790);
  const call = async (body, ip = '1.1.1.1') => { const r = await fetch(`http://127.0.0.1:${port}/api/quiz`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => null) }; };
  const A = hex(), B = hex();
  const KEY = [0, 1, 2, 2, 0];

  // start
  let r = await call({ action: 'start', handle: 'Sai Kiran', secret: A });
  ok('start returns run + 5 questions', r.s === 200 && r.j.questions.length === 5 && r.j.run_id, r);
  ok('questions do not leak the key', !JSON.stringify(r.j).match(/correct|explanation/i), r.j.questions[0]);
  const run = r.j.run_id, qs = r.j.questions;

  // handle protection
  r = await call({ action: 'start', handle: 'sai kiran', secret: B }, '2.2.2.2');
  ok('same handle, other secret, any case -> 409 handle_taken', r.s === 409 && r.j.error === 'handle_taken', r);

  // validation
  r = await call({ action: 'start', handle: 'x', secret: A }); ok('short handle -> 400', r.s === 400, r);
  r = await call({ action: 'start', handle: 'Fine', secret: 'abc' }); ok('bad secret -> 400', r.s === 400, r);
  r = await call({ action: 'nope' }); ok('unknown action -> 400', r.s === 400, r);

  // ordering and ownership
  r = await call({ action: 'answer', run_id: run, secret: A, question: 3, choice: 2 }); ok('out of order -> 409', r.s === 409 && r.j.error === 'out_of_order', r);
  r = await call({ action: 'answer', run_id: run, secret: B, question: 1, choice: 0 }); ok('wrong secret -> 403', r.s === 403, r);

  // play: q1 right, q2 wrong, q3..q5 right
  const picks = [0, 3, 2, 2, 0];
  const res = [];
  for (let i = 0; i < 5; i++) {
    r = await call({ action: 'answer', run_id: run, secret: A, question: qs[i].id, choice: picks[i] });
    res.push(r);
  }
  ok('graded answers (4 right, 1 wrong)', res.map(x => x.j.correct).join() === 'true,false,true,true,true', res.map(x => x.j));
  ok('wrong answer scores 0 and reveals key', res[1].j.points === 0 && res[1].j.correct_idx === 1 && res[1].j.explanation, res[1].j);
  ok('right answers score 100..150', res.filter(x => x.j.correct).every(x => x.j.points >= 100 && x.j.points <= 150), res.map(x => x.j.points));
  r = await call({ action: 'answer', run_id: run, secret: A, question: qs[4].id, choice: 0 });
  ok('answer after the last question -> 409', r.s === 409, r);
  r = await call({ action: 'finish', run_id: run, secret: A });
  ok('finish totals the run', r.s === 200 && r.j.correct === 4 && r.j.score === res.reduce((a, x) => a + x.j.points, 0), r);
  const first = r.j;
  r = await call({ action: 'finish', run_id: run, secret: A }); ok('finish twice -> 409', r.s === 409, r);

  // leaderboard
  r = await call({ action: 'board', secret: A });
  ok('board has one row, is_me for owner', r.j.rows.length === 1 && r.j.rows[0].is_me === true && r.j.rows[0].place === 1 && r.j.rows[0].attempts === 1 && r.j.rows[0].best_score === first.score, r.j);
  r = await call({ action: 'board' }); ok('board hides is_me without secret', r.j.rows[0].is_me === false, r.j);

  // second player and a worse second run for the first player
  const C = hex();
  r = await call({ action: 'start', handle: 'Rival', secret: C }, '3.3.3.3'); const run2 = r.j.run_id;
  for (let i = 0; i < 5; i++) await call({ action: 'answer', run_id: run2, secret: C, question: r.j.questions[i].id, choice: KEY[i] }, '3.3.3.3');
  const fin2 = await call({ action: 'finish', run_id: run2, secret: C }, '3.3.3.3');
  ok('perfect run scores >= 500', fin2.j.correct === 5 && fin2.j.score >= 500, fin2);
  r = await call({ action: 'start', handle: 'Sai Kiran', secret: A }); const run3 = r.j.run_id;
  for (let i = 0; i < 5; i++) await call({ action: 'answer', run_id: run3, secret: A, question: r.j.questions[i].id, choice: 3 });
  await call({ action: 'finish', run_id: run3, secret: A });
  r = await call({ action: 'board', secret: A });
  ok('board orders by best score; worse retry keeps best, attempts=2', r.j.rows[0].handle === 'Rival' && r.j.rows[1].handle === 'Sai Kiran' && r.j.rows[1].best_score === first.score && r.j.rows[1].attempts === 2 && r.j.rows[1].place === 2, r.j.rows);

  // rate limit by address
  let last; for (let i = 0; i < 22; i++) last = await call({ action: 'start', handle: 'Flood' + i, secret: hex() }, '9.9.9.9');
  ok('21st run from one address -> 429', last.s === 429 && last.j.error === 'rate_limited', last);

  // access control at the database level
  let denied = 0;
  for (const t of ['players', 'questions', 'runs', 'run_answers', 'leaderboard']) {
    try { await db.exec(`set role anon; select * from ${t};`); } catch (e) { denied++; } finally { await db.exec('reset role;'); }
  }
  ok('anon role cannot read any table', denied === 5, denied);
  let fnDenied = false; try { await db.exec(`set role anon; select get_board(5,'');`); } catch (e) { fnDenied = true; } finally { await db.exec('reset role;'); }
  ok('anon role cannot call procedures', fnDenied);

  // data sanity
  const q = await db.query(`select (select count(*) from runs where finished_at is not null) f, (select count(*) from leaderboard) l`);
  ok('runs and leaderboard consistent', Number(q.rows[0].f) === 3 && Number(q.rows[0].l) === 2, q.rows[0]);

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  server.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
