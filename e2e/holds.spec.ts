import { test, expect, createMini, requestMini, apiCall } from './support/fixtures';
import { Page } from '@playwright/test';

// The hold line across several people: getting in line, the owner seeing who's
// waiting, the first person being checked out automatically when the mini is
// back, and the notify list hearing about a free spot.

async function openMini(page: Page, name: string) {
  await page.goto('/');
  await page.getByText(name, { exact: true }).click();
}

async function notificationsInclude(page: Page, text: string | RegExp) {
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByRole('button', { name: text })).toBeVisible();
  await page.getByRole('button', { name: /^Notifications/ }).click(); // close again
}

test('when a request is cancelled, the first person in line is checked out and everyone hears where they stand', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const wendy = await as('wendy');
  const theo = await as('theo');
  const nina = await as('nina');
  const ada = await as('ada');

  const miniId = await createMini(olivia, 'Owlbear');
  const brunosRequest = await requestMini(bruno, miniId);

  // --- People line up from the detail view ---
  await openMini(wendy, 'Owlbear');
  await expect(wendy.getByText('0 of 3 holds.', { exact: false })).toBeVisible();
  await wendy.getByRole('button', { name: 'Place a hold' }).click();
  await expect(wendy.getByText('You\'re #1 in line')).toBeVisible();

  await openMini(theo, 'Owlbear');
  await theo.getByRole('button', { name: 'Place a hold' }).click();
  await expect(theo.getByText('You\'re #2 in line')).toBeVisible();

  await ada.goto('/');
  await ada.getByRole('button', { name: /^Chicago/ }).click();
  await ada.getByText('Owlbear', { exact: true }).click();
  await ada.getByRole('button', { name: 'Place a hold' }).click();
  await expect(ada.getByText('You\'re #3 in line')).toBeVisible();

  // --- The line is full: Nina asks to be told when a spot opens ---
  await openMini(nina, 'Owlbear');
  await expect(nina.getByText('The line is full.', { exact: false })).toBeVisible();
  await expect(nina.getByRole('button', { name: 'Place a hold' })).toHaveCount(0);
  await nina.getByRole('button', { name: 'Notify me when a spot opens' }).click();
  await expect(nina.getByText('We\'ll let you know when a spot opens.', { exact: false })).toBeVisible();

  // --- The owner sees who is waiting, in order; nobody else sees names ---
  await openMini(olivia, 'Owlbear');
  const line = olivia.getByRole('list', { name: 'Waiting in line' });
  await expect(line).toContainText('1. Wendy Waiting');
  await expect(line).toContainText('2. Theo Third');
  await expect(line).toContainText('3. Ada Admin');
  await expect(theo.getByText('Wendy Waiting')).toHaveCount(0);

  // --- Bruno backs out ---
  await bruno.goto('/loans');
  await bruno.getByRole('button', { name: 'Cancel request' }).click();
  await bruno.getByRole('button', { name: 'Yes, cancel' }).click();
  await expect(bruno.getByRole('region', { name: 'History' })).toContainText('Cancelled');
  expect(brunosRequest).toBeGreaterThan(0);

  // --- Wendy was first: it's now her request, and she's told ---
  await wendy.goto('/');
  await wendy.getByRole('button', { name: /^Notifications/ }).click();
  await wendy.getByRole('button', { name: 'It\'s your turn — you can now negotiate for Owlbear' }).click();
  await expect(wendy).toHaveURL(/\/loans$/);
  await expect(wendy.getByRole('region', { name: 'With Olivia Owner' })).toContainText('Owlbear');
  await expect(wendy.getByRole('region', { name: 'Waiting in line' })).toHaveCount(0);

  // --- Theo and Ada moved up ---
  await theo.goto('/');
  await notificationsInclude(theo, 'You moved up to #1 in line for Owlbear');
  await theo.goto('/loans');
  await expect(theo.getByRole('region', { name: 'Waiting in line' })).toContainText('#1 in line');
  await ada.goto('/');
  await notificationsInclude(ada, 'You moved up to #2 in line for Owlbear');

  // --- Nina hears a spot opened, and takes it ---
  await nina.goto('/');
  await notificationsInclude(nina, 'A hold spot opened on Owlbear');
  await openMini(nina, 'Owlbear');
  await nina.getByRole('button', { name: 'Place a hold' }).click();
  await expect(nina.getByText('You\'re #3 in line')).toBeVisible();

  // --- The owner heard about the holds and the automatic request ---
  await olivia.goto('/');
  await notificationsInclude(olivia, 'Wendy Waiting\'s hold on Owlbear is now a request');
  await openMini(olivia, 'Owlbear');
  await expect(olivia.locator('.badge-requested').first()).toHaveText('Requested');
});

test('nobody in line can negotiate while the mini is still out adventuring', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const wendy = await as('wendy');
  const miniId = await createMini(olivia, 'Dire Wolf');
  const loanId = await requestMini(bruno, miniId);
  await apiCall(bruno, 'PATCH', `/api/loans/${loanId}/terms`, { when: '2026-10-01T18:00:00.000Z', where: 'Shop', how: 'In person' });
  await apiCall(olivia, 'PATCH', `/api/loans/${loanId}/terms`, { durationDays: 7 });
  await apiCall(bruno, 'POST', `/api/loans/${loanId}/approve`);
  await apiCall(olivia, 'POST', `/api/loans/${loanId}/handoff`);

  await openMini(wendy, 'Dire Wolf');
  await expect(wendy.getByRole('button', { name: /Not available — out adventuring/ })).toBeDisabled();
  await wendy.getByRole('button', { name: 'Place a hold' }).click();
  await expect(wendy.getByText('You\'re #1 in line')).toBeVisible();

  await wendy.goto('/loans');
  await expect(wendy.getByRole('region', { name: 'Waiting in line' })).toContainText('Dire Wolf');
  await expect(wendy.getByRole('button', { name: 'Propose terms' })).toHaveCount(0);

  // Returned → Wendy is checked out automatically.
  await olivia.goto('/loans');
  await olivia.getByRole('button', { name: 'Mark returned' }).click();
  await wendy.reload();
  await expect(wendy.getByRole('region', { name: 'With Olivia Owner' })).toContainText('Dire Wolf');
  await expect(wendy.getByRole('button', { name: 'Propose terms' })).toBeVisible();
});

test('you can leave the line from the Loans page', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const wendy = await as('wendy');
  const miniId = await createMini(olivia, 'Beholder');
  await requestMini(bruno, miniId);
  await apiCall(wendy, 'POST', `/api/holds/minis/${miniId}`);

  await wendy.goto('/loans');
  await wendy.getByRole('button', { name: 'Leave the line for Beholder' }).click();

  await expect(wendy.getByRole('region', { name: 'Waiting in line' })).toHaveCount(0);
  await openMini(wendy, 'Beholder');
  await expect(wendy.getByRole('button', { name: 'Place a hold' })).toBeVisible();
});
