import { test, expect, createMini } from './support/fixtures';
import { Page } from '@playwright/test';

// The whole borrowing journey, two people in two browser windows:
// browse → cart → checkout → negotiate → both approve → handoff → adventuring → returned.

async function openBell(page: Page) {
  await page.getByRole('button', { name: /^Notifications/ }).click();
}

async function openNotification(page: Page, text: string | RegExp) {
  await openBell(page);
  await page.getByRole('button', { name: text }).click();
  await expect(page).toHaveURL(/\/loans$/);
}

function loanWith(page: Page, displayName: string) {
  return page.getByRole('region', { name: `With ${displayName}` });
}

test('borrowing a mini from request to return, with the handoff confirmed by the owner', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  await createMini(olivia, 'Dire Wolf', { tags: 'painted' });

  // --- Bruno finds it, puts it in his cart, and checks out ---
  await bruno.goto('/');
  await bruno.getByText('Dire Wolf').click();
  await bruno.getByRole('button', { name: 'Add to cart' }).click();
  await expect(bruno.getByRole('button', { name: /In your cart/ })).toBeDisabled();
  await bruno.getByRole('button', { name: 'Close' }).click();

  await bruno.getByRole('link', { name: 'Cart', exact: true }).click();
  await expect(bruno.getByRole('region', { name: 'From Olivia Owner' })).toContainText('Dire Wolf');
  await bruno.getByRole('button', { name: 'Checkout' }).click();
  await expect(bruno.getByText(/Sent 1 request/)).toBeVisible();

  // --- Olivia is told, and opens the request from the bell ---
  await olivia.goto('/');
  await expect(olivia.getByRole('button', { name: 'Notifications (1 unread)' })).toBeVisible();
  await openNotification(olivia, /Bruno Borrower requested Dire Wolf/);

  const oliviaCard = loanWith(olivia, 'Bruno Borrower');
  await expect(oliviaCard).toContainText('Dire Wolf');
  await expect(oliviaCard).toContainText(/Set the duration and agree on when, where, and how/);
  await oliviaCard.getByLabel('Duration (days)').fill('7');
  await oliviaCard.getByRole('button', { name: 'Propose terms' }).click();

  // --- Bruno fills in when, where, how (the terms are now complete, which counts as his approval) ---
  await bruno.getByRole('link', { name: 'Loans', exact: true }).click();
  const brunoCard = loanWith(bruno, 'Olivia Owner');
  await expect(brunoCard).toContainText('Loan length: 7 days (set by Olivia Owner)');
  await brunoCard.getByLabel('When').fill('2026-10-01T18:30');
  await brunoCard.getByLabel('Where').fill('Game night at the shop');
  await brunoCard.getByLabel('How').fill('In person');
  await brunoCard.getByRole('button', { name: 'Propose terms' }).click();
  await expect(brunoCard).toContainText('🔑 You: approved');
  await expect(brunoCard).toContainText('Waiting on Olivia Owner to approve.');

  // --- Olivia's open page catches up when she checks her notifications ---
  await openNotification(olivia, /Bruno Borrower proposed new terms for Dire Wolf/);
  await expect(oliviaCard).toContainText('Bruno Borrower approved these terms — approve too to agree.');
  await expect(oliviaCard.getByLabel('Where')).toHaveValue('Game night at the shop');
  await oliviaCard.getByRole('button', { name: 'Approve terms' }).click();

  // --- Both keys turned: only the owner can confirm the handoff ---
  await expect(oliviaCard).toContainText('You\'re both agreed. When you meet and hand it over, confirm the handoff.');
  await openNotification(bruno, /Olivia Owner approved the terms for Dire Wolf — you're both agreed/);
  await expect(brunoCard).toContainText('Agreed! Olivia Owner will confirm the handoff when you meet.');
  await expect(brunoCard.getByRole('button', { name: 'Confirm handoff' })).toHaveCount(0);

  await oliviaCard.getByRole('button', { name: 'Confirm handoff' }).click();
  await expect(oliviaCard).toContainText('Adventuring');
  await expect(oliviaCard).toContainText(/6d 23h left|7d 0h left/);

  // --- Bruno is told it's his, with the due date, and sees the countdown ---
  await openNotification(bruno, /Olivia Owner confirmed the handoff — Dire Wolf is adventuring with you until/);
  await expect(brunoCard).toContainText('Adventuring');
  await expect(brunoCard).toContainText(/left/);
  await expect(brunoCard.getByRole('button', { name: 'Mark returned' })).toHaveCount(0);

  // --- Everyone else sees it's out ---
  await bruno.goto('/');
  await expect(bruno.locator('.badge-adventuring')).toHaveText('Adventuring');

  // --- Olivia gets it back ---
  await olivia.reload();
  await loanWith(olivia, 'Bruno Borrower').getByRole('button', { name: 'Mark returned' }).click();
  await expect(olivia.getByRole('region', { name: 'History' })).toContainText('Returned');

  await openNotification(bruno, /Olivia Owner marked Dire Wolf as returned/);
  await bruno.goto('/');
  await expect(bruno.locator('.badge-available')).toHaveText('Available');
});

test('changing the terms after both agreed asks the other person to approve again', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  await createMini(olivia, 'Owlbear');

  await bruno.goto('/');
  await bruno.getByText('Owlbear').click();
  await bruno.getByRole('button', { name: 'Add to cart' }).click();
  await bruno.getByRole('button', { name: 'Close' }).click();
  await bruno.getByRole('link', { name: 'Cart', exact: true }).click();
  await bruno.getByRole('button', { name: 'Checkout' }).click();

  await bruno.getByRole('link', { name: 'Loans', exact: true }).click();
  const brunoCard = loanWith(bruno, 'Olivia Owner');
  await brunoCard.getByLabel('When').fill('2026-10-01T18:30');
  await brunoCard.getByLabel('Where').fill('Library');
  await brunoCard.getByLabel('How').fill('In person');
  await brunoCard.getByRole('button', { name: 'Propose terms' }).click();

  await olivia.goto('/loans');
  const oliviaCard = loanWith(olivia, 'Bruno Borrower');
  await oliviaCard.getByLabel('Duration (days)').fill('7');
  await oliviaCard.getByRole('button', { name: 'Propose terms' }).click();
  // Her change cleared Bruno's earlier approval; her own proposal counts as hers.
  await expect(oliviaCard).toContainText('🔑 Bruno Borrower: not yet');
  await expect(oliviaCard).toContainText('Waiting on Bruno Borrower to approve. Once they do, you\'ll confirm the handoff here when you meet.');

  await bruno.reload();
  await expect(brunoCard).toContainText('Olivia Owner approved these terms — approve too to agree.');
  await brunoCard.getByRole('button', { name: 'Approve terms' }).click();
  await expect(brunoCard).toContainText('Agreed!');

  await olivia.reload();
  await expect(oliviaCard.getByRole('button', { name: 'Confirm handoff' })).toBeEnabled();
});

test('either side can cancel a request before the handoff, and the mini is available again', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  await createMini(olivia, 'Beholder');

  await bruno.goto('/');
  await bruno.getByText('Beholder').click();
  await bruno.getByRole('button', { name: 'Add to cart' }).click();
  await bruno.getByRole('button', { name: 'Close' }).click();
  await bruno.getByRole('link', { name: 'Cart', exact: true }).click();
  await bruno.getByRole('button', { name: 'Checkout' }).click();

  await olivia.goto('/');
  await expect(olivia.locator('.badge-requested')).toHaveText('Requested');

  await bruno.getByRole('link', { name: 'Loans', exact: true }).click();
  await bruno.getByRole('button', { name: 'Cancel request' }).click();
  await bruno.getByRole('button', { name: 'Yes, cancel' }).click();
  await expect(bruno.getByRole('region', { name: 'History' })).toContainText('Cancelled');

  await openNotification(olivia, /Bruno Borrower cancelled the request for Beholder/);
  await olivia.goto('/');
  await expect(olivia.locator('.badge-available')).toHaveText('Available');
});
