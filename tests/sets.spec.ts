import { test, expect, createMini, apiCall } from './support/fixtures';

// Sets: grouping an owner's own minis into a named group (a boxed army, a Kill
// Team) so someone else can borrow the whole thing in one action instead of
// one mini at a time.

test('creating a set, borrowing it as a whole, and checking out becomes one loan per mini', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  await createMini(olivia, 'Banshee');
  await createMini(olivia, 'Farseer');

  await olivia.goto('/sets');
  await expect(olivia.getByText(/no sets yet/i)).toBeVisible();

  await olivia.getByLabel('Name').fill('Blades of Khaine');
  await olivia.getByLabel('Banshee').check();
  await olivia.getByLabel('Farseer').check();
  await olivia.getByRole('button', { name: 'Create Set' }).click();

  await expect(olivia.getByRole('region', { name: 'Blades of Khaine' })).toContainText('Banshee');
  await expect(olivia.getByRole('region', { name: 'Blades of Khaine' })).toContainText('Farseer');
  // It's Olivia's own set — nothing to borrow from herself.
  await expect(olivia.getByRole('button', { name: /borrow this set/i })).toHaveCount(0);

  // A card on the browse page says which set each mini belongs to.
  await olivia.goto('/');
  await expect(olivia.getByText('Part of: Blades of Khaine').first()).toBeVisible();

  // Bruno borrows the whole thing in one click.
  await bruno.goto('/sets');
  const brunoSet = bruno.getByRole('region', { name: 'Blades of Khaine' });
  await brunoSet.getByRole('button', { name: /borrow this set/i }).click();
  await expect(brunoSet).toContainText('Added 2 minis to your cart');

  await bruno.getByRole('link', { name: 'Go to your cart' }).click();
  await expect(bruno).toHaveURL(/\/cart$/);
  await expect(bruno.getByText('Banshee')).toBeVisible();
  await expect(bruno.getByText('Farseer')).toBeVisible();

  // Checkout needs no special "set" handling — it's just two ordinary requests.
  await bruno.getByRole('button', { name: 'Checkout' }).click();
  await expect(bruno.getByText(/Sent 2 requests/)).toBeVisible();

  await bruno.goto('/loans');
  await expect(bruno.getByText('Banshee')).toBeVisible();
  await expect(bruno.getByText('Farseer')).toBeVisible();
});

test('skips a member already out on loan, adds the rest, and says why', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const wendy = await as('wendy');
  const banshee = await createMini(olivia, 'Banshee');
  await createMini(olivia, 'Farseer');

  await olivia.goto('/sets');
  await olivia.getByLabel('Name').fill('Squad');
  await olivia.getByLabel('Banshee').check();
  await olivia.getByLabel('Farseer').check();
  await olivia.getByRole('button', { name: 'Create Set' }).click();

  // Bruno takes Banshee out on his own, ahead of Wendy borrowing the set.
  await apiCall(bruno, 'POST', '/api/cart', { miniId: banshee });
  await apiCall(bruno, 'POST', '/api/cart/checkout');

  await wendy.goto('/sets');
  const wendySet = wendy.getByRole('region', { name: 'Squad' });
  await wendySet.getByRole('button', { name: /borrow this set/i }).click();

  await expect(wendySet).toContainText('Added 1 mini to your cart');
  await expect(wendySet).toContainText('Banshee: not available right now');
});

test('removing a member frees it up, and deleting a set keeps its minis', async ({ as }) => {
  const olivia = await as('olivia');
  await createMini(olivia, 'Banshee');

  await olivia.goto('/sets');
  await olivia.getByLabel('Name').fill('Squad');
  await olivia.getByLabel('Banshee').check();
  await olivia.getByRole('button', { name: 'Create Set' }).click();

  const card = olivia.getByRole('region', { name: 'Squad' });
  await card.getByRole('button', { name: 'Remove Banshee from Squad' }).click();
  await expect(card.getByText(/nothing in this set yet/i)).toBeVisible();

  await card.getByRole('button', { name: 'Delete Set' }).click();
  await expect(card.getByText(/its minis stay/i)).toBeVisible();
  await card.getByRole('button', { name: 'Yes, delete' }).click();

  await expect(olivia.getByText(/no sets yet/i)).toBeVisible();
  await olivia.goto('/');
  await expect(olivia.getByText('Banshee')).toBeVisible(); // the mini itself survived
});
