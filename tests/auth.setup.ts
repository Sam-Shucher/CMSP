import { test as setup, expect } from '@playwright/test';
import { USERS, PASSWORD, emailOf } from './support/seed.cjs';
import { authFile } from './support/fixtures';

// Sign each seeded user in through the real sign-in page, once, and save the
// browser state so tests start already signed in.
for (const username of Object.keys(USERS)) {
  setup(`sign in as ${username}`, async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(emailOf(username));
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // One-group users land on the browse page; Ada (two groups) gets the picker.
    await expect(page.getByRole('heading', { name: /The Collection|Select a Group/ })).toBeVisible();
    await page.context().storageState({ path: authFile(username) });
  });
}
