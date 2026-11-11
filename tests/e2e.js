const { chromium } = require('playwright');
const { boot } = require('./server.js');
const RIGHT = ['The application tier only', 'It only presents information and sends input; the business rules and data stay on the server', 'Only the HTML the server sent, never the server-side program that produced it', '2 ms', 'Atomicity'];
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  const { server, port } = await boot(8791);
  const b = await chromium.launch();
  const newPage = async (vp = { width: 1280, height: 860 }) => { const ctx = await b.newContext({ viewport: vp }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/fonts|ERR_|Failed to load resource/.test(m.text())) errs.push(m.text()); }); p.errs = errs; return p; };
  const url = `http://127.0.0.1:${port}/#quiz`;

  const p = await newPage();
  await p.goto(url); await p.waitForTimeout(600);
  await p.fill('#handle', 'Sai Kiran'); await p.keyboard.press('Enter');
  await p.waitForSelector('.opt', { timeout: 5000 });
  const noLeak = await p.evaluate(() => !/must not exist|presentation work only|sends only its result|1 × 2 = 2 ms|all steps happen or none/i.test(document.documentElement.outerHTML));
  ok('page source and DOM hold no explanation text before answering', noLeak);
  for (let i = 0; i < 5; i++) {
    await p.waitForSelector('.opt:not([aria-disabled])'); await p.waitForTimeout(150);
    const idx = await p.evaluate(t => [...document.querySelectorAll('.opt')].findIndex(b => b.textContent.slice(1).trim() === t), RIGHT[i]);
    await p.click(`.opt:nth-child(${idx + 1})`);
    await p.waitForSelector('.why .verdict.ok', { timeout: 5000 });
    if (i === 0) await p.screenshot({ path: 'e_ans.png' });
    await p.keyboard.press('Enter');
  }
  await p.waitForSelector('.score', { timeout: 5000 }); await p.waitForSelector('.save.good', { timeout: 5000 }); await p.waitForTimeout(1500);
  const score = await p.textContent('.score'); const save = await p.textContent('#saveline');
  ok('perfect run scores 500..750', +score >= 500 && +score <= 750, score);
  ok('result says saved and shows rank', /saved/i.test(save) && /rank #1 of 1/.test(save), save);
  await p.screenshot({ path: 'e_result.png' });
  await p.evaluate(() => location.hash = 'leaderboard'); await p.waitForTimeout(800);
  const row = await p.textContent('#fullboard .brow.me'); ok('leaderboard shows me', /Sai Kiran/.test(row) && /YOU/.test(row) && /5\/5/.test(row), row);
  await p.screenshot({ path: 'e_board.png' });

  // another browser (new secret) cannot take the same callsign
  const p2 = await newPage(); await p2.goto(url); await p2.waitForTimeout(500);
  await p2.fill('#handle', 'sai kiran'); await p2.keyboard.press('Enter'); await p2.waitForTimeout(800);
  const hint = await p2.textContent('#hint'); ok('callsign taken message', /belongs to another player/.test(hint), hint);
  await p2.screenshot({ path: 'e_taken.png' });
  // but sees the board and a different name works
  await p2.fill('#handle', 'Rival_2'); await p2.keyboard.press('Enter'); await p2.waitForSelector('.opt', { timeout: 5000 });
  ok('different callsign starts a run', true);
  await p2.evaluate(() => location.hash = 'leaderboard'); await p2.waitForTimeout(800);
  const rows = await p2.$$eval('#fullboard .brow:not(.head)', r => r.map(x => x.textContent));
  ok('second browser sees first player but not as YOU', rows.length === 1 && /Sai Kiran/.test(rows[0]) && !/YOU/.test(rows[0]), rows);

  // phone layout
  const p3 = await newPage({ width: 390, height: 800 }); await p3.goto(url); await p3.waitForTimeout(500);
  await p3.fill('#handle', 'Phone_1'); await p3.keyboard.press('Enter'); await p3.waitForSelector('.opt'); await p3.screenshot({ path: 'e_phone.png' });
  ok('phone: no horizontal scroll', await p3.evaluate(() => document.documentElement.scrollWidth) <= 390);

  // home page mini board + no console errors
  const p4 = await newPage(); await p4.goto(`http://127.0.0.1:${port}/`); await p4.waitForTimeout(4200);
  const mini = await p4.textContent('#miniboard'); ok('home mini-board lists the player', /Sai Kiran/.test(mini), mini.slice(0, 80));
  for (const [n, pg] of [['p', p], ['p2', p2], ['p3', p3], ['p4', p4]]) ok('no page errors in ' + n, pg.errs.length === 0, pg.errs);

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
