import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test('note editing keys, task checkboxes, and sidebar context menu', async ({ page }) => {
  const { password } = JSON.parse(fs.readFileSync(process.env.HUH_TEST_AUTH_FILE || '../.artifacts/test-auth.json', 'utf8'));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: 'New meeting', exact: true }).click();
  const title = `Editor keys ${Date.now()}`;
  await page.getByLabel('Meeting title').fill(title);
  await page.getByLabel('Meeting title').blur();

  const notes = page.getByLabel('Meeting notes', { exact: true });
  await notes.click();
  await page.keyboard.type('- [ ] first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  await expect(notes).toHaveValue('- [ ] first\n- [ ] second');
  await page.keyboard.press('Tab');
  await expect(notes).toHaveValue('- [ ] first\n    - [ ] second');
  await expect(notes).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(notes).toHaveValue('- [ ] first\n- [ ] second');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // empty item ends the list
  await page.keyboard.type('plain');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await expect(notes).toHaveValue('- [ ] first\n- [ ] second\n\tplain');
  await page.keyboard.press('Control+z');
  await expect(notes).toHaveValue('- [ ] first\n- [ ] second\nplain');

  // Checkboxes render in Preview and toggle the source.
  await page.getByRole('radio', { name: 'Preview' }).first().click();
  const boxes = page.locator('.tab-panel:not([hidden]) .task-box');
  await expect(boxes).toHaveCount(2);
  await boxes.first().click();
  await expect(boxes.first()).toBeChecked();
  await page.getByRole('radio', { name: 'Write' }).first().click();
  await expect(notes).toHaveValue('- [x] first\n- [ ] second\nplain');
  await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible({ timeout: 10000 });

  // Right-click in the sidebar → Delete → confirm.
  await page.locator('.meeting-link', { hasText: title }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(title);
  await dialog.getByRole('button', { name: 'Delete meeting' }).click();
  await expect(page.locator('.meeting-link', { hasText: title })).toHaveCount(0);
  expect(errors).toEqual([]);
});
