import { test, expect, createMini } from './support/fixtures';
import { authFile } from './support/fixtures';

// People mostly arrange lends from their phones. At phone width nothing may be
// wider than the screen — otherwise the browser zooms the whole page out and
// it scrolls sideways.

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

test('every main page fits a phone screen, nav included', async ({ browser, as }) => {
  const olivia = await as('olivia');
  await createMini(olivia, 'A mini with a rather long name so the card has to wrap nicely');

  const context = await browser.newContext({ ...PHONE, storageState: authFile('olivia') });
  const phone = await context.newPage();
  for (const path of ['/', '/upload', '/cart', '/loans', '/profile']) {
    await phone.goto(path);
    await expect(phone.getByRole('button', { name: 'Logout' })).toBeVisible();
    const width = await phone.evaluate(() => document.documentElement.scrollWidth);
    expect(width, `${path} is wider than the phone`).toBeLessThanOrEqual(390);
  }

  // Every nav link is on screen and tappable, not pushed off the edge.
  await phone.goto('/');
  for (const name of ['Browse', 'Add Mini', 'Cart', 'Loans', 'Sets', 'olivia']) {
    const box = await phone.locator('nav').getByRole('link', { name, exact: true }).boundingBox();
    expect(box, name).not.toBeNull();
    expect(box!.x + box!.width, `${name} runs off the screen`).toBeLessThanOrEqual(390);
  }
  await context.close();
});
