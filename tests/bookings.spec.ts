import { test, expect, createMini, requestMini, apiCall } from './support/fixtures';
import { Page } from '@playwright/test';

// Feature 13: "I need it for game night on the 14th." A booking claims days on
// the calendar whether or not the mini is free today, and a loan that would
// still be out when those days come is refused at the handoff.

// A day this many days from now, the way <input type="date"> takes it. Far
// enough out that the server's "today" and the browser's can't disagree.
function daysFromNow(days: number): string {
  const day = new Date();
  day.setDate(day.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

async function openMini(page: Page, name: string) {
  await page.goto('/');
  await page.getByText(name).click();
}

function loanWith(page: Page, displayName: string) {
  return page.getByRole('region', { name: `With ${displayName}` });
}

test('booking a mini for a day, and a loan that would run into it being refused at the handoff', async ({ as }) => {
  const olivia = await as('olivia');
  const wendy = await as('wendy');
  const bruno = await as('bruno');
  const miniId = await createMini(olivia, 'Owlbear');

  // --- Wendy books it for game night, ten days out ---
  await openMini(wendy, 'Owlbear');
  await wendy.getByLabel('From').fill(daysFromNow(10));
  await wendy.getByLabel('What for').fill('game night at the shop');
  await wendy.getByRole('button', { name: 'Book these days' }).click();
  await expect(wendy.getByRole('list', { name: 'Booked days' })).toContainText('booked by you · game night at the shop');

  // --- Olivia, who owns it, is told and sees who booked it ---
  await olivia.goto('/');
  await olivia.getByRole('button', { name: /^Notifications/ }).click();
  await expect(olivia.getByRole('button', { name: /Wendy Waiting booked Owlbear for/ })).toBeVisible();
  await openMini(olivia, 'Owlbear');
  await expect(olivia.getByRole('list', { name: 'Booked days' })).toContainText('booked by Wendy Waiting');
  await expect(olivia.getByRole('button', { name: 'Book these days' })).toHaveCount(0); // not on your own mini

  // --- Bruno sees the days are taken, but not by whom ---
  await openMini(bruno, 'Owlbear');
  const brunoView = bruno.getByRole('list', { name: 'Booked days' });
  await expect(brunoView).toContainText('booked');
  await expect(brunoView).not.toContainText('Wendy');

  // Nor can he claim the same day.
  const clash = await apiCall<{ error: string }>(bruno, 'POST', `/api/bookings/minis/${miniId}`, {
    startsOn: daysFromNow(10), endsOn: daysFromNow(10),
  });
  expect(clash.status).toBe(409);

  // --- Bruno borrows it now, for two weeks — which would have it out on Wendy's day ---
  const loanId = await requestMini(bruno, miniId);
  await apiCall(bruno, 'PATCH', `/api/loans/${loanId}/terms`, { when: '2026-10-01T18:00:00.000Z', where: 'Shop', how: 'In person' });
  await apiCall(olivia, 'PATCH', `/api/loans/${loanId}/terms`, { durationDays: 14 });
  await apiCall(bruno, 'POST', `/api/loans/${loanId}/approve`);

  await olivia.goto('/loans');
  const oliviaCard = loanWith(olivia, 'Bruno Borrower');
  await oliviaCard.getByRole('button', { name: 'Confirm handoff' }).click();
  await expect(oliviaCard).toContainText(/Wendy Waiting has this booked from .+, so it needs to be back before then/);
  await expect(oliviaCard).not.toContainText('Adventuring');

  // --- A week instead, back before Wendy's day, goes through ---
  await apiCall(olivia, 'PATCH', `/api/loans/${loanId}/terms`, { durationDays: 7 });
  await apiCall(bruno, 'POST', `/api/loans/${loanId}/approve`);
  await olivia.reload();
  await loanWith(olivia, 'Bruno Borrower').getByRole('button', { name: 'Confirm handoff' }).click();
  await expect(loanWith(olivia, 'Bruno Borrower')).toContainText('Adventuring');

  // --- Now that it's out, anyone else is told when it's back before picking a day ---
  const theo = await as('theo');
  await openMini(theo, 'Owlbear');
  await expect(theo.getByRole('note')).toContainText(/out on loan until .*earliest you can book is/i);
  await expect(theo.getByLabel('From')).toHaveAttribute('min', daysFromNow(8));

  // --- Wendy keeps track of it from her Loans page, and can let it go ---
  await wendy.goto('/loans');
  const booked = wendy.getByRole('region', { name: 'Booked days' });
  await expect(booked).toContainText('Owlbear');
  await expect(booked).toContainText('from Olivia Owner · game night at the shop');
  await booked.getByRole('button', { name: 'Cancel the booking on Owlbear' }).click();
  await expect(wendy.getByRole('region', { name: 'Booked days' })).toHaveCount(0);

  // The days are free again for anyone.
  const { body } = await apiCall<{ bookings: unknown[] }>(bruno, 'GET', `/api/bookings/minis/${miniId}`);
  expect(body.bookings).toEqual([]);
});
