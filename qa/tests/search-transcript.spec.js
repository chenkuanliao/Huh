import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test('transcript player, find in tab, command palette, hidden AI sources, date titles', async ({ page }) => {
  test.setTimeout(120000);
  const { password } = JSON.parse(fs.readFileSync(process.env.HUH_TEST_AUTH_FILE || '../.artifacts/test-auth.json', 'utf8'));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();

  // A meeting with real (GPU-transcribed) speech.
  const title = `Search ${Date.now()}`;
  const m = await (await page.request.post('/api/meetings', { data: { title } })).json();
  const audio = fs.readFileSync('../.artifacts/voice-memo.m4a');
  const up = await (await page.request.post(`/api/meetings/${m.id}/uploads`, { data: { filename: 'memo.m4a', mime_type: 'audio/mp4', size: audio.length, mode: 'additional' } })).json();
  expect((await page.request.put(`/api/recordings/${up.recording_id}/chunks/0`, { headers: { 'content-type': 'audio/mp4', 'x-recording-token': up.token }, data: audio })).ok()).toBeTruthy();
  expect((await page.request.post(`/api/recordings/${up.recording_id}/finish`, { data: { token: up.token, chunk_count: 1 } })).ok()).toBeTruthy();
  await expect.poll(async () => (await (await page.request.get(`/api/meetings/${m.id}`)).json()).recordings[0].status, { timeout: 90000 }).toBe('transcribed');
  // Let the automatic AI-notes run finish so our edit below doesn't race it.
  await expect.poll(async () => (await (await page.request.get(`/api/meetings/${m.id}`)).json()).jobs.some(j => j.kind === 'generate' && j.status === 'completed'), { timeout: 60000 }).toBe(true);
  const detail = await (await page.request.get(`/api/meetings/${m.id}`)).json();
  // AI notes with hidden source markers.
  const edited = await page.request.patch(`/api/meetings/${m.id}`, { data: { enhanced_notes: '## Summary\n- A call to serve the country [[0:00, notes]]', enhanced_revision: detail.enhanced_revision } });
  expect(edited.ok()).toBeTruthy();

  await page.goto('/');
  await page.locator('.meeting-link', { hasText: title }).click();

  // Hidden sources: no markers in preview; hover reveals them.
  await page.getByRole('tab', { name: 'AI notes', exact: true }).click();
  const preview = page.locator('.tab-panel:not([hidden]) .note-preview');
  await expect(preview).toContainText('A call to serve the country');
  await expect(preview).not.toContainText('[[');
  await preview.locator('li', { hasText: 'serve the country' }).hover();
  const card = page.locator('.source-card');
  await expect(card).toContainText('0:00');
  await expect(card).toContainText('From your written notes');
  await card.getByRole('button', { name: /0:00/ }).click();
  await expect(page.getByRole('tab', { name: /^Transcript/ })).toHaveAttribute('aria-selected', 'true');

  // Player: exact duration from the playback copy; timestamps move the playhead without playing.
  const player = page.locator('.player').first();
  await expect(player.locator('.player-time').nth(1)).toHaveText(/^0:1\d$/, { timeout: 10000 });
  const stamps = page.locator('.segment .timestamp');
  await stamps.last().click();
  const target = await stamps.last().textContent();
  await expect(player.locator('.player-time').first()).toHaveText(target);
  expect(await page.locator('audio').first().evaluate(a => a.paused)).toBe(true);
  await expect(page.locator('.segment.active')).toHaveCount(1);

  // Find in tab: highlights + count + next.
  await page.keyboard.press('Control+f');
  const find = page.getByRole('search');
  await find.getByLabel('Find in this tab').fill('you');
  await expect(find.locator('.find-count')).toHaveText(/^1 of [2-9]/);
  await page.keyboard.press('Enter');
  await expect(find.locator('.find-count')).toHaveText(/^2 of /);
  expect(await page.evaluate(() => CSS.highlights.get('huh-find')?.size)).toBeGreaterThan(1);
  await page.keyboard.press('Escape');
  await expect(find).toHaveCount(0);

  // Find works while typing a note (Write mode).
  await page.getByRole('tab', { name: 'My notes', exact: true }).click();
  await page.getByLabel('Meeting notes', { exact: true }).fill('alpha beta alpha');
  await page.keyboard.press('Control+f');
  await page.getByLabel('Find in this tab').fill('alpha');
  await expect(page.locator('.find-count')).toHaveText('1 of 2');
  await expect(page.locator('.find-mirror mark')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.find-mirror')).toHaveCount(0);

  // Ctrl+K: actions and names, from anywhere (content search isn't in the palette).
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search and actions' });
  const input = palette.getByLabel('Search meetings, folders, settings and actions');
  await input.fill('country');
  await expect(palette.locator('.palette-empty')).toBeVisible();
  await input.fill('>transcription');
  await expect(palette.locator('.palette-cmd')).toHaveCount(0);
  await input.fill('transcription');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Transcription', exact: true }).first()).toBeVisible();

  // New meetings are titled with their creation time.
  await page.getByRole('button', { name: 'New meeting', exact: true }).click();
  await expect(page.getByLabel('Meeting title')).toHaveValue(/^\w{3}, \w{3} \d{1,2} · \d{1,2}:\d{2}\s?[AP]M$/);
  expect(errors).toEqual([]);
});
