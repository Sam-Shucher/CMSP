import { test, expect, createMini, requestMini, apiCall } from './support/fixtures';
import { Page } from '@playwright/test';

// The whole borrowing journey, two people in two browser windows:
// browse → cart → checkout → negotiate → both approve → handoff → "got it" → adventuring → returned.

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

// The count beside the Cart link in the nav.
function cartCount(page: Page) {
  return page.locator('nav').getByTestId('cart-count');
}

test('the nav shows how many minis are in your cart, and stops once you check out', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  await createMini(olivia, 'Dire Wolf');
  await createMini(olivia, 'Owlbear');

  // Nothing in the cart, nothing on the link.
  await bruno.goto('/');
  await expect(bruno.getByRole('link', { name: 'Cart', exact: true })).toBeVisible();
  await expect(cartCount(bruno)).toHaveCount(0);

  await bruno.getByText('Dire Wolf').click();
  await bruno.getByRole('button', { name: 'Add to cart' }).click();
  await expect(cartCount(bruno)).toHaveText('1');
  await bruno.getByRole('button', { name: 'Close' }).click();

  await bruno.getByText('Owlbear').click();
  await bruno.getByRole('button', { name: 'Add to cart' }).click();
  await expect(cartCount(bruno)).toHaveText('2');
  await bruno.getByRole('button', { name: 'Close' }).click();

  // It survives a reload — the count is the cart, not something held in the tab.
  await bruno.reload();
  await expect(cartCount(bruno)).toHaveText('2');

  // Taking one back out counts down…
  await bruno.getByRole('link', { name: 'Cart', exact: true }).click();
  await bruno.getByRole('button', { name: /Remove Owlbear/ }).click();
  await expect(cartCount(bruno)).toHaveText('1');

  // …and checking out empties it.
  await bruno.getByRole('button', { name: 'Checkout' }).click();
  await expect(bruno.getByText(/Sent 1 request/)).toBeVisible();
  await expect(cartCount(bruno)).toHaveCount(0);
});

// Keeping a mini longer, and the library rule that a reserved one can't be.
test('a borrower keeps a mini longer, until somebody gets in line for it', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const wendy = await as('wendy');
  const miniId = await createMini(olivia, 'Dire Wolf');

  // Straight to adventuring: the journey itself is covered by the test below.
  const loanId = await requestMini(bruno, miniId);
  await apiCall(bruno, 'PATCH', `/api/loans/${loanId}/terms`, { when: '2026-10-01T18:00:00.000Z', where: 'Shop', how: 'In person' });
  await apiCall(olivia, 'PATCH', `/api/loans/${loanId}/terms`, { durationDays: 7 });
  await apiCall(bruno, 'POST', `/api/loans/${loanId}/approve`);
  await apiCall(olivia, 'POST', `/api/loans/${loanId}/handoff`);

  await bruno.goto('/loans');
  const brunoCard = loanWith(bruno, 'Olivia Owner');
  await expect(brunoCard).toContainText(/6d 23h left|7d 0h left/);

  // A week more, asked for and granted on the spot.
  await brunoCard.getByLabel('More days').fill('7');
  await brunoCard.getByRole('button', { name: 'Keep it longer' }).click();
  await expect(brunoCard).toContainText(/13d 23h left|14d 0h left/);

  // Olivia hears about it, since the date she agreed to has moved. (She has
  // other unread notices from agreeing the loan, so this opens the one.)
  await olivia.goto('/loans');
  await openNotification(olivia, /Bruno Borrower kept Dire Wolf for 7 more days/);

  // Wendy joins the line — now nobody can keep it longer.
  await wendy.goto('/');
  await wendy.getByText('Dire Wolf').click();
  await wendy.getByRole('button', { name: /Place a hold/ }).click();
  await expect(wendy.getByText(/You're #1 in line/)).toBeVisible();

  await bruno.reload();
  await expect(brunoCard).toContainText('Someone is waiting in line for Dire Wolf, so it can\'t be kept longer.');
  await expect(brunoCard.getByRole('button', { name: 'Keep it longer' })).toHaveCount(0);

  // And the server says no even if the button is gone from the page only.
  const refused = await apiCall<{ error: string }>(bruno, 'POST', `/api/loans/${loanId}/extend`, { extraDays: 7 });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toMatch(/waiting in line/);
});

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

  // --- Bruno confirms he got it; Olivia is told and sees the ✓ (the clock already started at her handoff) ---
  await expect(oliviaCard).toContainText('Bruno Borrower hasn\'t confirmed they got it yet.');
  await expect(oliviaCard.getByRole('button', { name: 'Got it' })).toHaveCount(0);
  await brunoCard.getByRole('button', { name: 'Got it' }).click();
  await expect(brunoCard).toContainText('✓ You confirmed you got it');
  await expect(brunoCard.getByRole('button', { name: 'Got it' })).toHaveCount(0);

  await openNotification(olivia, /Bruno Borrower confirmed they got Dire Wolf/);
  await expect(oliviaCard).toContainText('✓ Bruno Borrower confirmed they got it');
  await expect(oliviaCard).toContainText(/6d 23h left|7d 0h left/);

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
