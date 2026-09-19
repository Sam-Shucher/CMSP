import { test, expect, createMini, requestMini } from './support/fixtures';
import { query } from './support/seed.cjs';

// Tidying up the bell: dismissing, putting one back to unread, and read ones
// disappearing two days after they were read.

test('dismissing a notification, marking one unread, and the two-day countdown', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const wolf = await createMini(olivia, 'Dire Wolf');
  await createMini(olivia, 'Owlbear');
  await requestMini(bruno, wolf);

  await olivia.goto('/');
  const bell = olivia.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName('Notifications (1 unread)');
  await bell.click();

  // Unread: no countdown yet.
  const row = olivia.getByRole('listitem').filter({ hasText: 'Bruno Borrower requested Dire Wolf' });
  await expect(row).not.toContainText('Disappears in');

  await olivia.getByRole('button', { name: 'Mark all read' }).click();
  await expect(bell).toHaveAccessibleName('Notifications');
  // Two days, less however many seconds the read took to land — a countdown
  // that starts a second late reads "1d 23h", which is right, not broken.
  await expect(row).toContainText(/Disappears in (2d|1d 23h)/);

  // Back to unread — it counts again and stops counting down.
  await row.getByRole('button', { name: 'Mark as unread' }).click();
  await expect(bell).toHaveAccessibleName('Notifications (1 unread)');
  await expect(row).not.toContainText('Disappears in');
  await expect(row.getByRole('button', { name: 'Mark as unread' })).toHaveCount(0);

  // Dismissed for good — still gone after a reload.
  await row.getByRole('button', { name: 'Dismiss' }).click();
  await expect(olivia.getByRole('listitem')).toHaveCount(0);
  await expect(olivia.getByText(/no notifications yet/i)).toBeVisible();
  await olivia.reload();
  await expect(bell).toHaveAccessibleName('Notifications');
});

test('a notification read more than two days ago is gone', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const wolf = await createMini(olivia, 'Dire Wolf');
  const owlbear = await createMini(olivia, 'Owlbear');
  await requestMini(bruno, wolf);
  await requestMini(bruno, owlbear);

  await olivia.goto('/');
  await olivia.getByRole('button', { name: /^Notifications/ }).click();
  await olivia.getByRole('button', { name: 'Mark all read' }).click();
  await expect(olivia.getByRole('listitem')).toHaveCount(2);

  // One of them was read three days ago.
  await query("UPDATE notifications SET read_at = NOW() - INTERVAL 3 DAY WHERE message LIKE '%Dire Wolf%'");
  await olivia.reload();
  await olivia.getByRole('button', { name: /^Notifications/ }).click();

  const rows = olivia.getByRole('listitem');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Owlbear');
});
