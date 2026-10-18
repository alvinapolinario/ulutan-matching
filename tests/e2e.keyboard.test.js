'use strict';
/**
 * Browser tests for the keyboard-first workflow (real Chromium).
 * Needs playwright-core and a Chromium/Chrome binary. Set CHROMIUM_PATH if it is not found.
 * Skipped automatically when no browser is available.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { setup } = require('./helpers');

let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { chromium = null; }
const candidates = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].filter(Boolean);
const exe = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
const skip = !chromium || !exe ? 'no Chromium available (set CHROMIUM_PATH)' : false;

async function loginPage(browser, ctx, user, pass) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${ctx.url}/login`);
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await Promise.all([page.waitForNavigation(), page.click('button')]);
  return page;
}
const focusedId = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);

test('e2e: registration and matching work from the keyboard', { skip, timeout: 60000 }, async (t) => {
  const ctx = await setup();
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(async () => { await browser.close(); await ctx.stop(); });

  // ---------- Registration ----------
  const page = await loginPage(browser, ctx, 'op', 'op1234');
  await page.goto(`${ctx.url}/registration`);
  assert.equal(await focusedId(page), 'participantName');
  for (const owner of ['Alvin', 'Joel', 'Robin']) {
    await page.keyboard.type(owner);
    await page.keyboard.press('Enter');
    assert.equal(await focusedId(page), 'entryName');
    await page.keyboard.press('Enter');
    assert.equal(await focusedId(page), 'address');
    await page.keyboard.type(`Brgy. ${owner}, Iligan City`);
    await page.keyboard.press('Enter');
    await page.waitForFunction((o) => document.getElementById('lastSaved').textContent.includes(o), owner);
    assert.equal(await focusedId(page), 'participantName', 'focus returns for the next entry');
  }
  assert.equal(ctx.store.data.entries.length, 3);
  assert.equal(ctx.store.data.entries[0].address, 'Brgy. Alvin, Iligan City');
  assert.match(await page.textContent('#lastSaved'), /005/);

  // ---------- Matching ----------
  await page.goto(`${ctx.url}/matching`);
  assert.equal(await focusedId(page), 'redInput', 'Red is focused on open');

  // Invalid red keeps focus and shows an error
  await page.keyboard.type('99');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#redInfo.bad');
  assert.match(await page.textContent('#redInfo'), /099 is not registered/);
  await page.waitForFunction(() => document.activeElement.id === 'redInput');

  // Valid red moves to blue
  await page.fill('#redInput', '1');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement.id === 'blueInput');
  assert.equal(await page.inputValue('#redInput'), '001');
  await page.waitForSelector('#redInfo.ok');
  assert.match(await page.textContent('#redInfo'), /Alvin/);

  // Same-entry blue is rejected and focus stays on blue
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#blueInfo.bad');
  assert.match(await page.textContent('#blueInfo'), /same entry/);
  assert.equal(await focusedId(page), 'blueInput');

  // Valid blue opens the dialog; a quick second Enter must NOT confirm
  await page.fill('#blueInput', '3');
  await page.keyboard.down('Enter');
  await page.waitForSelector('#confirmModal.show');
  await page.waitForTimeout(600);
  assert.equal(await page.isDisabled('#confirmBtn'), true, 'Confirm stays disabled while Enter is held');
  await page.keyboard.up('Enter');
  await page.waitForFunction(() => !document.getElementById('confirmBtn').disabled);
  assert.equal(ctx.store.data.matches.length, 0, 'opening the dialog never creates a match');
  assert.match(await page.textContent('#confirmRed'), /001/);
  assert.match(await page.textContent('#confirmBlue'), /Joel/);

  // Escape closes without saving and keeps both numbers
  await page.keyboard.press('Escape');
  await page.waitForSelector('#confirmModal', { state: 'hidden' });
  await page.waitForFunction(() => document.activeElement.id === 'blueInput');
  assert.equal(ctx.store.data.matches.length, 0);
  assert.equal(await page.inputValue('#redInput'), '001');
  assert.equal(await page.inputValue('#blueInput'), '003');

  // Enter again -> dialog -> explicit Enter on the armed Confirm button
  await page.keyboard.press('Enter');
  await page.waitForSelector('#confirmModal.show');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'confirmBtn');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#confirmModal', { state: 'hidden' });
  await page.waitForFunction(() => document.activeElement.id === 'redInput');
  assert.equal(ctx.store.data.matches.length, 1);
  assert.equal(ctx.store.data.matches[0].fightNumber, 1);
  assert.equal(await page.inputValue('#redInput'), '');
  assert.equal(await page.inputValue('#blueInput'), '');
  await page.waitForFunction(() => document.getElementById('recentRows').textContent.includes('#001'));
  assert.match(await page.textContent('#toasts'), /Fight #001 confirmed/);

  // Very fast typing: keys typed right after Red's Enter land in Blue, not Red
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#confirmModal.show');
  assert.equal(await page.inputValue('#redInput'), '002');
  assert.equal(await page.inputValue('#blueInput'), '005');
  assert.match(await page.textContent('#confirmBlue'), /Robin/);
  await page.click('#editBtn');
});

test('e2e: TV display updates live without reload', { skip, timeout: 60000 }, async (t) => {
  const ctx = await setup();
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(async () => { await browser.close(); await ctx.stop(); });
  for (const p of ['A', 'B', 'C', 'D']) ctx.services.registration.register(ctx.eventId, { participantName: p }, ctx.adminUser.id);
  const tv = await loginPage(browser, ctx, 'tv', 'tv1234');
  assert.match(tv.url(), /\/display$/);
  await tv.waitForFunction(() => document.getElementById('standbyTitle').textContent === 'NO FIGHTS YET');
  const user = ctx.store.data.users.find((u) => u.username === 'op');
  ctx.services.matches.confirm(ctx.eventId, { red: '001', blue: '003', idempotencyKey: 'tv-test-0001' }, user);
  await tv.waitForFunction(() => document.getElementById('nowNo').textContent === 'FIGHT #001');
  assert.equal(await tv.textContent('#nowLabel'), 'FIRST FIGHT');
  ctx.services.matches.confirm(ctx.eventId, { red: '005', blue: '007', idempotencyKey: 'tv-test-0002' }, user);
  ctx.services.matches.advance(ctx.eventId, user, 'next');
  await tv.waitForFunction(() => document.getElementById('nowLabel').textContent === 'NOW FIGHTING');
  assert.match(await tv.textContent('#nextBody'), /FIGHT #002/);
  await tv.screenshot({ path: require('path').join(ctx.dataDir, 'tv.png') });
});

test('e2e: draw mode — Red, Blue, drawn fight number, confirm', { skip, timeout: 60000 }, async (t) => {
  const ctx = await setup({ fightNumberMode: 'DRAW' });
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(async () => { await browser.close(); await ctx.stop(); });
  for (const p of ['A', 'B', 'C']) ctx.services.registration.register(ctx.eventId, { participantName: p }, ctx.adminUser.id);
  const page = await loginPage(browser, ctx, 'op', 'op1234');
  await page.goto(`${ctx.url}/matching`);
  // Fast typing straight through all three fields
  await page.keyboard.type('1'); await page.keyboard.press('Enter');
  await page.keyboard.type('3'); await page.keyboard.press('Enter');
  await page.keyboard.type('27'); await page.keyboard.press('Enter');
  await page.waitForSelector('#confirmModal.show');
  assert.equal(await page.inputValue('#blueInput'), '003');
  assert.equal(await page.inputValue('#fightInput'), '27');
  assert.match(await page.textContent('#confirmFightNo'), /FIGHT #027/);
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'confirmBtn');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#confirmModal', { state: 'hidden' });
  await page.waitForFunction(() => document.activeElement.id === 'redInput');
  assert.equal(ctx.store.data.matches[0].fightNumber, 27);
  assert.equal(await page.inputValue('#fightInput'), '');
  // Taken number: error on the fight field, legbands kept
  await page.keyboard.type('2'); await page.keyboard.press('Enter');
  await page.keyboard.type('5'); await page.keyboard.press('Enter');
  await page.keyboard.type('27'); await page.keyboard.press('Enter');
  await page.waitForSelector('#fightInfo.bad');
  assert.match(await page.textContent('#fightInfo'), /Fight #027 is already used/);
  await page.waitForFunction(() => document.activeElement.id === 'fightInput');
  assert.equal(await page.inputValue('#redInput'), '002');
  await page.keyboard.type('8'); await page.keyboard.press('Enter');
  await page.waitForSelector('#confirmModal.show');
  assert.match(await page.textContent('#confirmFightNo'), /FIGHT #008/);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement.id === 'fightInput');
  assert.equal(ctx.store.data.matches.length, 1);
});
