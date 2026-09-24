import { test, expect, createMini, requestMini, apiCall, TINY_PNG } from './support/fixtures';
import { Page } from '@playwright/test';

// Feature 12: a note and a photo at each end of a loan, so "the spear was
// already bent" is a fact instead of an argument. Two people in two windows,
// with a bystander checking the photo stays private to the loan.

async function adventuring(owner: Page, borrower: Page, miniName: string): Promise<number> {
  const miniId = await createMini(owner, miniName);
  const loanId = await requestMini(borrower, miniId);
  await apiCall(borrower, 'PATCH', `/api/loans/${loanId}/terms`, { when: '2026-10-01T18:00:00.000Z', where: 'Shop', how: 'In person' });
  await apiCall(owner, 'PATCH', `/api/loans/${loanId}/terms`, { durationDays: 7 });
  await apiCall(borrower, 'POST', `/api/loans/${loanId}/approve`);
  await apiCall(owner, 'POST', `/api/loans/${loanId}/handoff`);
  return loanId;
}

function loanWith(page: Page, displayName: string) {
  return page.getByRole('region', { name: `With ${displayName}` });
}

// A photo the browser actually managed to load and draw.
async function expectPhotoShown(page: Page, alt: string) {
  const img = page.getByRole('img', { name: alt });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
}

test('both sides record how a mini looked at the handoff, with a photo only they can see, and the return after', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const wendy = await as('wendy');
  const loanId = await adventuring(olivia, bruno, 'Dire Wolf');

  // --- Olivia records the handoff, with a photo ---
  await olivia.goto('/loans');
  const oliviaCard = loanWith(olivia, 'Bruno Borrower');
  await oliviaCard.getByRole('button', { name: 'Record how it looks' }).click();
  await expect(oliviaCard.getByLabel('Which end')).toHaveValue('handoff');
  await oliviaCard.getByLabel('Note', { exact: true }).fill('Spear straight, base scuffed on the left');
  await oliviaCard.getByLabel(/Photos/).setInputFiles({ name: 'wolf.png', mimeType: 'image/png', buffer: TINY_PNG });
  await oliviaCard.getByRole('button', { name: 'Record' }).click();

  const oliviaNotes = oliviaCard.getByRole('list', { name: 'Condition notes' });
  await expect(oliviaNotes).toContainText('At the handoff · Olivia Owner');
  await expect(oliviaNotes).toContainText('Spear straight, base scuffed on the left');
  await expectPhotoShown(olivia, 'At the handoff, by Olivia Owner');

  // --- Bruno is told, sees her note and photo, and adds his own account ---
  await bruno.goto('/');
  await bruno.getByRole('button', { name: /^Notifications/ }).click();
  await bruno.getByRole('button', { name: /Olivia Owner recorded how Dire Wolf looked at the handoff/ }).click();
  await expect(bruno).toHaveURL(/\/loans$/);

  const brunoCard = loanWith(bruno, 'Olivia Owner');
  await brunoCard.getByRole('button', { name: 'Condition notes (1)' }).click();
  await expect(brunoCard.getByRole('list', { name: 'Condition notes' })).toContainText('Spear straight, base scuffed on the left');
  await expectPhotoShown(bruno, 'At the handoff, by Olivia Owner');

  await brunoCard.getByLabel('Note', { exact: true }).fill('Spear looked a little bent to me');
  await brunoCard.getByRole('button', { name: 'Record' }).click();
  await expect(brunoCard.getByRole('list', { name: 'Condition notes' })).toContainText('At the handoff · Bruno Borrower');

  // Saying it again isn't possible — the record can't be rewritten.
  const again = await apiCall<{ error: string }>(bruno, 'POST', `/api/loans/${loanId}/condition`, { phase: 'handoff', note: 'Actually it was fine' });
  expect(again.status).toBe(409);

  // --- The photo is the loan's two people's business, not the group's ---
  const { body: reports } = await apiCall<{ photos: string[] }[]>(olivia, 'GET', `/api/loans/${loanId}/condition`);
  const photoUrl = reports.flatMap(r => r.photos)[0];
  expect((await bruno.request.get(photoUrl)).status()).toBe(200);
  expect((await wendy.request.get(photoUrl)).status()).toBe(404);
  expect((await apiCall(wendy, 'GET', `/api/loans/${loanId}/condition`)).status).toBe(404);

  // --- Back home: the handoff is closed, the return is still open ---
  await apiCall(olivia, 'POST', `/api/loans/${loanId}/return`, { outcome: 'returned' });
  await olivia.reload();
  const history = olivia.getByRole('region', { name: 'History' });
  await history.getByRole('button', { name: 'Condition notes (2)' }).click();
  const phase = history.getByLabel('Which end');
  await expect(phase.locator('option')).toHaveCount(1);
  await expect(phase).toHaveValue('return');

  await history.getByLabel('Note', { exact: true }).fill('Came back with a chipped base');
  await history.getByRole('button', { name: 'Record' }).click();
  await expect(history.getByRole('list', { name: 'Condition notes' })).toContainText('At the return · Olivia Owner');
  await expect(history.getByRole('list', { name: 'Condition notes' })).toContainText('Came back with a chipped base');
});
