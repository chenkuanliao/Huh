import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('one-click start, live microphone swap, and decodable audio', async ({ browser, baseURL }) => {
  test.setTimeout(120000);
  const { password } = JSON.parse(fs.readFileSync(process.env.HUH_TEST_AUTH_FILE || '../.artifacts/test-auth.json', 'utf8'));
  const context = await browser.newContext({ baseURL, permissions: ['microphone'] });
  const errors = [];
  try {
    expect((await context.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: 'New meeting', exact: true }).click();
    const title = `Mic swap ${Date.now()}`;
    await page.getByLabel('Meeting title').fill(title);
    await page.getByLabel('Meeting title').blur();
    // Start without turning the microphone on first.
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.locator('.rec-indicator.live')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(4500);
    await page.getByRole('button', { name: 'Recording source' }).click();
    await page.getByRole('combobox', { name: 'Microphone' }).click();
    await page.getByRole('option', { name: 'Fake Audio Input 1' }).click();
    await expect(page.getByText('Switched microphone — recording continues.')).toBeVisible();
    await expect(page.locator('.rec-indicator.live')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recording source' })).toContainText('Fake Audio Input 1');
    await page.waitForTimeout(4500);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.rec-indicator.live')).toHaveCount(0, { timeout: 15000 });
    const mid = (await (await context.request.get('/api/meetings')).json()).find(m => m.title === title).id;
    // A single recording continues across the swap and the worker can decode it.
    await expect.poll(async () => (await (await context.request.get(`/api/meetings/${mid}`)).json()).recordings.map(r => r.status), { timeout: 90000 }).toEqual(['transcribed']);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
