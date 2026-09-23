import { Page } from '@playwright/test';
import { test, expect, createMini, apiCall } from './support/fixtures';

// Screenshots of the main pages, compared with the last approved ones, so a
// stray CSS change that breaks a layout — overlapping buttons, a form pushed
// off a phone screen — fails a test instead of reaching the Pi.
//
// The first run has nothing to compare with, so make the baselines once:
//   npx playwright test tests/visual.spec.ts --update-snapshots
// and look at them in tests/visual.spec.ts-snapshots/ before committing.
// They're per operating system (fonts render differently), so they're made
// and checked on the same machine. After a deliberate design change, update
// them the same way.
//
// Only pages whose content the test decides are shot — nothing with a clock,
// a countdown or a random name in it.

const PHONE = { width: 390, height: 844 };

async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
}

const shot = { fullPage: true, animations: 'disabled' as const, maxDiffPixelRatio: 0.01 };

test('sign-in page', async ({ guest }) => {
  const page = await guest();
  await page.goto('/login');
  await settled(page);
  await expect(page).toHaveScreenshot('login.png', shot);
});

test('sign-in page on a phone', async ({ guest }) => {
  const page = await guest();
  await page.setViewportSize(PHONE);
  await page.goto('/login');
  await settled(page);
  await expect(page).toHaveScreenshot('login-phone.png', shot);
});

test('browse page with two minis', async ({ as }) => {
  const olivia = await as('olivia');
  await createMini(olivia, 'Dire Wolf', { tags: 'painted' });
  await createMini(olivia, 'Owlbear', { tags: 'boss' });
  const bruno = await as('bruno');

  await bruno.goto('/');
  await expect(bruno.getByText('Owlbear')).toBeVisible();
  await settled(bruno);
  await expect(bruno).toHaveScreenshot('browse.png', shot);

  await bruno.setViewportSize(PHONE);
  await settled(bruno);
  await expect(bruno).toHaveScreenshot('browse-phone.png', shot);
});

test('a mini opened from the browse page', async ({ as }) => {
  const olivia = await as('olivia');
  await createMini(olivia, 'Dire Wolf', { tags: 'painted' });
  const bruno = await as('bruno');

  await bruno.goto('/');
  await bruno.getByText('Dire Wolf').click();
  await expect(bruno.getByRole('button', { name: 'Add to cart' })).toBeVisible();
  await settled(bruno);
  await expect(bruno).toHaveScreenshot('mini-detail.png', shot);
});

test('cart with one mini in it', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const miniId = await createMini(olivia, 'Dire Wolf');
  await apiCall(bruno, 'POST', '/api/cart', { miniId });

  await bruno.goto('/cart');
  await expect(bruno.getByRole('button', { name: 'Checkout' })).toBeVisible();
  await settled(bruno);
  await expect(bruno).toHaveScreenshot('cart.png', shot);
});

test('bulk add with a row ready to go', async ({ as }) => {
  const olivia = await as('olivia');
  await olivia.goto('/upload/bulk');
  await olivia.getByRole('button', { name: /paste from a spreadsheet/i }).click();
  await olivia.getByLabel(/spreadsheet rows/i).fill('name,tags,price\nDire Wolf,undead,12.50');
  await olivia.getByRole('button', { name: /add these rows/i }).click();
  await expect(olivia.getByRole('region', { name: 'Mini 1' })).toBeVisible();
  await settled(olivia);
  await expect(olivia).toHaveScreenshot('bulk-add.png', shot);
});
