import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test('dashboard summary and to-dos, focus mode with live preview', async ({ page }) => {
  const { password } = JSON.parse(fs.readFileSync(process.env.HUH_TEST_AUTH_FILE || '../.artifacts/test-auth.json', 'utf8'));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  const title = `Focus ${Date.now()}`;
  const created = await (await page.request.post('/api/meetings', { data: { title } })).json();
  const todo = `Email the slides ${Date.now()}`;
  expect((await page.request.patch(`/api/meetings/${created.id}`, { data: { notes: `## Next\n- [ ] ${todo}\n- [x] done already`, notes_revision: 0 } })).ok()).toBeTruthy();

  // Home dashboard is the landing page.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Good (morning|afternoon|evening)|Working late/);
  await expect(page.getByText('Meetings this week')).toBeVisible();
  const box = page.getByRole('checkbox', { name: `Complete: ${todo}` });
  await expect(box).toBeVisible();
  await box.click();
  await expect(box).toHaveCount(0, { timeout: 10000 });
  const after = await (await page.request.get(`/api/meetings/${created.id}`)).json();
  expect(after.notes).toContain(`- [x] ${todo}`);

  // Focus mode: hotkey, pure editor + live preview, nothing else on screen, Esc exits.
  await page.locator('.meeting-link', { hasText: title }).click();
  await page.getByLabel('Meeting title').click();
  await page.keyboard.press('Control+Shift+F');
  const focus = page.getByRole('dialog', { name: 'Focus mode' });
  await expect(focus).toBeVisible();
  await expect(page.locator('.recorder')).toBeHidden();
  const editor = focus.getByLabel('Meeting notes', { exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+End');
  // Enter continues the checklist; a second Enter on the empty item ends it.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Live heading');
  await expect(focus.locator('.focus-preview h2', { hasText: 'Live heading' })).toBeVisible();
  await expect(focus.getByText(/Saved/)).toBeVisible({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await expect(focus).toHaveCount(0);
  await expect(page.locator('.recorder')).toBeVisible();
  await expect(page.getByLabel('Meeting notes', { exact: true })).toHaveValue(/## Live heading/);
  // Toggle back in from the toolbar button.
  await page.getByRole('button', { name: 'Focus mode' }).click();
  await expect(focus).toBeVisible();
  await page.keyboard.press('Control+Shift+F');
  await expect(focus).toHaveCount(0);
  expect(errors).toEqual([]);
});
