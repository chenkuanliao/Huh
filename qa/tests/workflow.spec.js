import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('shared notes, conflict resolution, capture handoff, upload recovery and mobile layout', async ({ browser, baseURL }) => {
  test.setTimeout(120000);
  const { password } = JSON.parse(fs.readFileSync(process.env.HUH_TEST_AUTH_FILE || '../.artifacts/test-auth.json', 'utf8'));
  const contexts = [];
  const errors = [];
  async function device(name, mobile = false) {
    const context = await browser.newContext({ baseURL, permissions: ['microphone'], ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}) });
    contexts.push(context);
    const login = await context.request.post('/api/auth/login', { data: { password } });
    expect(login.ok()).toBeTruthy();
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/');
    await expect(page.getByRole('button', { name: mobile ? 'Toggle sidebar' : 'New meeting', exact: true })).toBeVisible();
    page.deviceName = name;
    return page;
  }
  // Device name and microphone live in the recording-setup popover of an open meeting.
  async function setup(page) {
    const chip = page.getByRole('button', { name: 'Recording source' });
    if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click();
    return page.getByRole('dialog', { name: 'Recording setup' });
  }
  async function closeSetup(page) {
    const chip = page.getByRole('button', { name: 'Recording source' });
    if ((await chip.getAttribute('aria-expanded')) === 'true') await chip.click();
  }
  async function nameDevice(page) {
    const panel = await setup(page);
    await panel.getByLabel('Device name').fill(page.deviceName);
    await closeSetup(page);
  }
  async function micOn(page) {
    const panel = await setup(page);
    await panel.getByRole('button', { name: 'Turn on microphone', exact: true }).click();
    await expect(panel.getByText('Mic on', { exact: true })).toBeVisible();
    await closeSetup(page);
  }
  const live = page => page.locator('.rec-indicator.live');
  try {
    const a = await device('Desktop test');
    await a.getByRole('button', { name: 'New meeting', exact: true }).click();
    const title = `Browser workflow ${Date.now()}`;
    await a.getByLabel('Meeting title').fill(title);
    await a.getByLabel('Meeting title').blur();
    await expect(a.locator('.meeting-link', { hasText: title })).toBeVisible();
    const list = await (await a.request.get('/api/meetings')).json();
    const mid = list.find(m => m.title === title).id;
    await nameDevice(a);
    const b = await device('MacBook test');
    await b.locator('.meeting-link', { hasText: title }).click();
    await nameDevice(b);
    await a.getByLabel('Meeting notes', { exact: true }).fill('Shared decision: ship bilingual notes. 決定下週再確認。');
    await expect(b.getByLabel('Meeting notes', { exact: true })).toHaveValue('Shared decision: ship bilingual notes. 決定下週再確認。', { timeout: 15000 });

    await a.getByLabel('Meeting notes', { exact: true }).fill('Local draft that must survive a conflict');
    const before = await (await b.request.get(`/api/meetings/${mid}`)).json();
    expect((await b.request.patch(`/api/meetings/${mid}`, { data: { notes: 'Changed from the other device', notes_revision: before.notes_revision } })).ok()).toBeTruthy();
    await expect(a.getByText('This note changed on another device.')).toBeVisible();
    await expect(a.getByLabel('Meeting notes', { exact: true })).toHaveValue('Local draft that must survive a conflict');
    await a.getByRole('button', { name: 'Use server version' }).click();
    await expect(a.getByLabel('Meeting notes', { exact: true })).toHaveValue('Changed from the other device');

    await micOn(a);
    await micOn(b);
    const panel = await setup(a);
    await expect(panel.getByRole('radio', { name: 'Record from MacBook test' })).toBeEnabled({ timeout: 10000 });
    await closeSetup(a);
    // Hold audio uploads offline while coordination remains connected.
    await a.route('**/api/recordings/*/chunks/*', route => route.abort());
    await a.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect(live(a)).toBeVisible({ timeout: 15000 });
    await a.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(live(a)).toBeVisible();
    await expect.poll(async () => (await (await b.request.get(`/api/meetings/${mid}`)).json()).recordings[0]?.chunk_count).toBe(0);
    await (await setup(b)).getByRole('button', { name: 'Move recording to this device' }).click();
    await expect(live(b)).toBeVisible({ timeout: 15000 });
    await expect(live(a)).toHaveCount(0, { timeout: 15000 });
    await expect(a.getByText(/pending audio upload/)).toBeVisible();
    await a.unroute('**/api/recordings/*/chunks/*');
    await expect(a.getByText(/pending audio upload/)).toHaveCount(0, { timeout: 15000 });
    await b.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(live(b)).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => {
      const detail = await (await b.request.get(`/api/meetings/${mid}`)).json();
      return detail.recordings.length === 2 && detail.recordings.every(r => r.chunk_count > 0 && !['starting', 'recording', 'stopping'].includes(r.status));
    }, { timeout: 15000 }).toBeTruthy();

    const mobile = await device('Phone test', true);
    await mobile.getByRole('button', { name: 'Toggle sidebar' }).click();
    await mobile.locator('.meeting-link', { hasText: title }).click();
    await expect(mobile.getByLabel('Meeting title')).toHaveValue(title);
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await mobile.getByRole('tab', { name: /^Transcript/ }).click();
    await expect(mobile.getByRole('heading', { name: 'The conversation' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map(c => c.close()));
  }
});
