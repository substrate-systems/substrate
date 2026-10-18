// Flow audit for the map page (round 57): hover never sticks, Back undoes the last step, review returns, show all resets.
// Serve the boards (tools/serve) and run: node flow-audit.js. Every line must start with OK.
const { chromium } = require('playwright');
const U = (o) => 'http://localhost:8958/?b=Viewer&p=' + encodeURIComponent(JSON.stringify(o));
const out = [];
const log = (k, v, ok) => out.push(`${ok === undefined ? '  ' : ok ? 'OK' : 'XX'} ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
(async () => { const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  const S = () => p.evaluate(() => { const s = document.querySelector('[data-dcs="Viewer"]').__inst.state; return { mode: s.mode, focus: s.focus, hist: s.hist.length, ret: s.ret ? s.ret.mode : null, hover: s.hover, rv: s.rv, showAll: s.showAll }; });
  const clickText = (sel, re) => p.evaluate(([sel, re]) => { const el = [...document.querySelectorAll(sel)].find(x => new RegExp(re).test(x.textContent) && x.offsetParent !== null); if (el) { el.click(); return el.textContent.trim().slice(0, 50); } return null; }, [sel, re]);
  const center = (sel, k = 0) => p.evaluate(([sel, k]) => { const n = [...document.querySelectorAll(sel)].filter(x => x.offsetParent !== null)[k]; if (!n) return null; const r = n.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, [sel, k]);
  await p.goto(U({ device: 'desktop', theme: 'light', start: 'overview', vault: 'sample' })); await p.waitForTimeout(2500);
  // A: hover and the void
  let c = await center('.nd.hub'); await p.mouse.move(c[0], c[1]); await p.waitForTimeout(300);
  let s = await S(); log('hover a note', s.hover, s.hover >= 0);
  await p.mouse.move(c[0] + 160, c[1] + 120); await p.waitForTimeout(300);
  s = await S(); log('pointer on empty map clears hover', s.hover, s.hover === -1);
  await p.mouse.move(c[0], c[1]); await p.waitForTimeout(300); await p.mouse.move(5, 300); await p.waitForTimeout(100); await p.mouse.move(-5, 300); await p.waitForTimeout(300);
  s = await S(); log('leaving the map clears hover', s.hover, s.hover === -1);
  // label hover = note hover
  c = await center('.lb:not(.hid):not(.cl)'); if (c) { await p.mouse.move(c[0], c[1]); await p.waitForTimeout(300); s = await S(); log('hover a name lights its note', { hover: s.hover, hov: await p.evaluate(() => document.querySelectorAll('.nd.hov').length) }, s.hover >= 0); }
  // B: focus, walk, back
  c = await center('.nd.hub'); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(900); s = await S(); log('click note -> note', s, s.mode === 'note' && s.focus >= 0);
  const f0 = s.focus;
  c = await center('.nd.nb', 1); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(900); s = await S(); log('click ring note -> next note, hist 1', s, s.mode === 'note' && s.hist === 1);
  await p.mouse.move(c[0], c[1]); await p.waitForTimeout(200);
  log('back label', await p.evaluate(() => [...document.querySelectorAll('button.ghost')].filter(x => x.offsetParent && /←/.test(x.textContent)).map(x => x.textContent).join(',')));
  await clickText('button.ghost', '^← back$'); await p.waitForTimeout(700); s = await S(); log('back -> first note', s, s.focus === f0 && s.mode === 'note');
  s = await S(); log('hover cleared after back', s.hover, s.hover === -1);
  await clickText('button.ghost', '^← overview$'); await p.waitForTimeout(700); s = await S(); log('back -> overview', s, s.mode === 'overview');
  // C: void click from a note
  c = await center('.nd.hub'); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(700);
  await p.mouse.click(300, 820); await p.waitForTimeout(700); s = await S(); log('click void in note -> overview, hover off', s, s.mode === 'overview' && s.hover === -1 && s.hist === 0);
  // D: read, map, why
  c = await center('.nd.hub'); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(700);
  await clickText('button', '^Read the note$'); await p.waitForTimeout(800); s = await S(); log('Read -> read', s.mode, s.mode === 'read');
  await clickText('button', '← map'); await p.waitForTimeout(800); s = await S(); log('← map -> note', s.mode, s.mode === 'note');
  await clickText('button', 'Why is this true'); await p.waitForTimeout(800); s = await S(); log('Why -> why', s.mode, s.mode === 'why');
  log('why back buttons', await p.evaluate(() => [...document.querySelectorAll('button')].filter(x => x.offsetParent && /←|back/i.test(x.textContent)).map(x => x.textContent.trim()).join(' | ')));
  // E: review card -> note -> back -> review
  await p.goto(U({ device: 'desktop', theme: 'light', start: 'review', vault: 'sample' })); await p.waitForTimeout(2500);
  await clickText('button', '→|Next'); await p.waitForTimeout(300); const rv0 = (await S()).rv;
  await p.evaluate(() => [...document.querySelectorAll('.card')].find(x => x.offsetParent).click()); await p.waitForTimeout(800); s = await S(); log('review card -> note (ret review)', s, s.mode === 'note' && s.ret === 'review');
  log('back label from review note', await p.evaluate(() => [...document.querySelectorAll('button.ghost')].filter(x => x.offsetParent && /←/.test(x.textContent)).map(x => x.textContent).join(',')));
  await clickText('button.ghost', '^← review$'); await p.waitForTimeout(800); s = await S(); log('back -> review, same pair', s, s.mode === 'review' && s.rv === rv0);
  // F: +more -> read links -> map ; show all toggles
  await p.goto(U({ device: 'desktop', theme: 'light', start: 'note', vault: 'large' })); await p.waitForTimeout(3000);
  await clickText('.lb.morel', 'Show all'); await p.waitForTimeout(800); s = await S(); log('show all on', s.showAll, s.showAll === s.focus);
  c = await center('.nd.nb', 3); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(900); s = await S(); log('focus another -> show all off', { showAll: s.showAll, focus: s.focus }, s.showAll !== s.focus);
  await clickText('button.ghost', '^← back$'); await p.waitForTimeout(800);
  await clickText('.lb.morel', 'more links'); await p.waitForTimeout(1500); s = await S(); log('+more -> read', s.mode, s.mode === 'read');
  await clickText('button', '← map'); await p.waitForTimeout(800); s = await S(); log('← map -> note', s.mode, s.mode === 'note');
  // G: search
  await p.goto(U({ device: 'desktop', theme: 'light', start: 'overview', vault: 'sample' })); await p.waitForTimeout(2500);
  await p.click('input'); await p.keyboard.type('gpu'); await p.waitForTimeout(600);
  const pick = await clickText('.prow, .trow, [role="option"]', 'gpu'); await p.waitForTimeout(800); s = await S(); log('search -> note', { pick, ...s }, s.mode === 'note');
  await p.keyboard.press('Escape'); await p.waitForTimeout(200); await p.keyboard.press('Escape'); await p.waitForTimeout(600); s = await S(); log('Escape from a note -> overview', s, s.mode === 'overview');
  log('errors', errs.slice(0, 3), errs.length === 0);
  console.log(out.join('\n')); await b.close(); })();
