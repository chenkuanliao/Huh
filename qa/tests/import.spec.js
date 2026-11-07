import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test('Voice Memos-compatible m4a import produces a real GPU transcript', async ({ page }) => {
  test.setTimeout(120000);
  const { password } = JSON.parse(fs.readFileSync(process.env.HUH_TEST_AUTH_FILE || '../.artifacts/test-auth.json', 'utf8'));
  expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: 'New meeting', exact: true }).click();
  await page.getByRole('button', { name: 'Recorder options' }).click();
  await page.getByRole('menuitem', { name: /Import an audio file/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Import audio' });
  await dialog.getByRole('radio', { name: 'Replace existing audio' }).click();
  await dialog.getByLabel('Audio file').setInputFiles('../.artifacts/voice-memo.m4a');
  await expect(page.getByText('Audio uploaded. Transcription has started.')).toBeVisible();
  await page.getByRole('tab', { name: /^Transcript/ }).click();
  await expect(page.locator('.segment')).toContainText(['country'], { timeout: 90000 });
  await page.getByRole('tab', { name: 'AI notes', exact: true }).click();
  // AI notes open in Preview by default.
  await expect(page.locator('.tab-panel:not([hidden]) .note-preview')).toContainText('Meeting notes', { timeout: 15000 });
});
