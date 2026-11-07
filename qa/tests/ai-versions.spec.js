import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test('meetings open on AI notes when present; choose which AI version is shown', async ({ page }) => {
  test.setTimeout(120000);
  const { password } = JSON.parse(fs.readFileSync(process.env.HUH_TEST_AUTH_FILE || '../.artifacts/test-auth.json', 'utf8'));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  const title = `Versions ${Date.now()}`;
  const m = await (await page.request.post('/api/meetings', { data: { title } })).json();
  const get = async () => (await page.request.get(`/api/meetings/${m.id}`)).json();

  // Without AI notes, the meeting opens on My notes.
  await page.goto('/');
  await page.locator('.meeting-link', { hasText: title }).click();
  await expect(page.getByRole('tab', { name: 'My notes', exact: true })).toHaveAttribute('aria-selected', 'true');

  // Audio → automatic first AI version; then a second, newer version.
  const audio = fs.readFileSync('../.artifacts/voice-memo.m4a');
  const up = await (await page.request.post(`/api/meetings/${m.id}/uploads`, { data: { filename: 'memo.m4a', mime_type: 'audio/mp4', size: audio.length, mode: 'additional' } })).json();
  await page.request.put(`/api/recordings/${up.recording_id}/chunks/0`, { headers: { 'content-type': 'audio/mp4', 'x-recording-token': up.token }, data: audio });
  await page.request.post(`/api/recordings/${up.recording_id}/finish`, { data: { token: up.token, chunk_count: 1 } });
  await expect.poll(async () => (await get()).generations.length, { timeout: 90000 }).toBe(1);
  expect((await page.request.post(`/api/meetings/${m.id}/generate`, { data: {} })).ok()).toBeTruthy();
  await expect.poll(async () => (await get()).generations.length, { timeout: 60000 }).toBe(2);
  const [newest, oldest] = (await get()).generations;
  expect(newest.content).not.toEqual(oldest.content);
  expect((await get()).enhanced_notes).toEqual(newest.content);

  // Reopening now lands on AI notes, showing the latest version.
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.locator('.meeting-link', { hasText: title }).click();
  await expect(page.getByRole('tab', { name: 'AI notes', exact: true })).toHaveAttribute('aria-selected', 'true');
  const picker = page.getByRole('combobox', { name: 'AI notes version' });
  await expect(picker).toContainText('Latest');
  const runOf = c => c.match(/Run \d+/)[0];
  await expect(page.locator('.tab-panel:not([hidden]) .note-preview')).toContainText(runOf(newest.content));

  // Pick the older version; it becomes the shown one (on every device).
  await picker.click();
  await page.getByRole('option').nth(1).click();
  await expect(page.locator('.tab-panel:not([hidden]) .note-preview')).toContainText(runOf(oldest.content));
  await expect(page.getByText('You’re viewing an older version.')).toBeVisible();
  expect((await get()).enhanced_notes).toEqual(oldest.content);
  await page.getByRole('button', { name: 'Show latest' }).click();
  await expect(page.locator('.tab-panel:not([hidden]) .note-preview')).toContainText(runOf(newest.content));
  await expect(picker).toContainText('Latest');

  // Ctrl/⌘+Shift+F always focuses My notes, even from the AI notes tab.
  await page.keyboard.press('Control+Shift+F');
  await expect(page.getByRole('dialog', { name: 'Focus mode' }).getByLabel('Meeting notes', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
