import { test, expect, createMini, requestMini, apiCall } from './support/fixtures';
import { Page } from '@playwright/test';
import { PASSWORD, emailOf } from './support/seed.cjs';

// The unlikely paths: a second tab, a page left open while someone else acts,
// a double-click, the back button. None of these is how the app is meant to be
// used, and all of them happen. Each should end with the page telling the
// truth — no crash, nothing done twice, nothing landing in the wrong group.

function loanWith(page: Page, displayName: string) {
  return page.getByRole('region', { name: `With ${displayName}` });
}

async function groupId(page: Page, name: string): Promise<number> {
  const { body } = await apiCall<{ id: number; name: string }[]>(page, 'GET', '/api/auth/collections');
  return body.find(group => group.name === name)!.id;
}

test('a second tab switching groups stops this tab acting in the old one, and says why', async ({ as }) => {
  const olivia = await as('olivia');
  const miniId = await createMini(olivia, 'Dire Wolf');

  // Ada belongs to Chicago and dojo. Two tabs, one sign-in.
  const tabA = await as('ada');
  await tabA.goto('/');
  await tabA.getByRole('button', { name: /^Chicago/ }).click();
  await expect(tabA.getByText('Dire Wolf')).toBeVisible();
  const chicago = await groupId(tabA, 'Chicago');

  const tabB = await tabA.context().newPage();
  await tabB.goto('/');
  await apiCall(tabB, 'POST', '/api/auth/select-collection', { collectionId: await groupId(tabB, 'dojo') });

  // Tab A still shows Chicago. A borrow sent from it, as the app sends it —
  // saying which group the page is showing — is refused.
  const borrow = await tabA.evaluate(async ({ miniId, chicago }) => {
    const res = await fetch('/api/cart', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Collection-Id': String(chicago) },
      body: JSON.stringify({ miniId }),
    });
    return { status: res.status, body: (await res.json()) as { code?: string } };
  }, { miniId, chicago });
  expect(borrow).toEqual({ status: 409, body: expect.objectContaining({ code: 'group_changed' }) });

  // The tab itself catches up at its next request — whichever comes first:
  // the cart and bell checking the moment it's back in front, or the next
  // page opened — and says why the page changed under you.
  await tabA.bringToFront();
  await tabA.getByRole('link', { name: 'Loans', exact: true }).click();
  await expect(tabA.getByRole('status').filter({ hasText: 'You switched to dojo in another tab' })).toBeVisible();
  // Nothing landed in either group's cart.
  expect((await apiCall<unknown[]>(tabA, 'GET', '/api/cart')).body).toEqual([]);
  await apiCall(tabA, 'POST', '/api/auth/select-collection', { collectionId: await groupId(tabA, 'Chicago') });
  expect((await apiCall<unknown[]>(tabA, 'GET', '/api/cart')).body).toEqual([]);
});

test('a message sent just as the other person cancels is refused, and the draft is kept', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const loanId = await requestMini(bruno, await createMini(olivia, 'Dire Wolf'));

  await bruno.goto('/loans');
  const card = loanWith(bruno, 'Olivia Owner');
  await card.getByRole('button', { name: 'Message Olivia Owner' }).click();
  await card.getByLabel('Message', { exact: true }).fill('On my way!');

  // Olivia backs out while Bruno is still typing.
  await apiCall(olivia, 'POST', `/api/loans/${loanId}/cancel`);

  await card.getByLabel('Message', { exact: true }).press('Enter');
  await expect(card).toContainText(/over|just ended/);
  await expect(card.getByLabel('Message', { exact: true })).toHaveValue('On my way!');
  expect((await apiCall<unknown[]>(bruno, 'GET', `/api/loans/${loanId}/messages`)).body).toEqual([]);
});

test('a mini deleted while someone has it open can\'t be borrowed, and the page says so', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const miniId = await createMini(olivia, 'Dire Wolf');

  await bruno.goto('/');
  await bruno.getByText('Dire Wolf').click();
  await expect(bruno.getByRole('button', { name: 'Add to cart' })).toBeVisible();

  expect((await apiCall(olivia, 'DELETE', `/api/minis/${miniId}`)).status).toBe(200);

  await bruno.getByRole('button', { name: 'Add to cart' }).click();
  await expect(bruno.getByText('Mini not found')).toBeVisible();
  expect((await apiCall<unknown[]>(bruno, 'GET', '/api/cart')).body).toEqual([]);
});

test('double-clicking Checkout sends each request once', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const miniId = await createMini(olivia, 'Dire Wolf');
  await apiCall(bruno, 'POST', '/api/cart', { miniId });

  await bruno.goto('/cart');
  await bruno.getByRole('button', { name: 'Checkout' }).dblclick();

  await expect(bruno.getByText(/Sent 1 request/)).toBeVisible();
  await expect(bruno.getByText(/cart is empty/i).and(bruno.locator('.error-msg'))).toHaveCount(0);
  const { body: loans } = await apiCall<unknown[]>(bruno, 'GET', '/api/loans');
  expect(loans).toHaveLength(1);
});

// Signs in afresh rather than using Bruno's saved session: signing out ends
// the session it's on, and every later test starts from the saved one.
test('the back button after signing out shows the sign-in page, not the last one', async ({ guest }) => {
  const bruno = await guest();
  await bruno.goto('/login');
  await bruno.getByLabel('Email').fill(emailOf('bruno'));
  await bruno.getByLabel('Password').fill(PASSWORD);
  await bruno.getByRole('button', { name: 'Sign In' }).click();
  await expect(bruno.getByRole('heading', { name: 'The Collection' })).toBeVisible();

  await bruno.goto('/loans');
  await expect(bruno.getByRole('heading', { name: /^loans$/i })).toBeVisible();

  await bruno.getByRole('button', { name: /logout/i }).click();
  await expect(bruno.getByRole('button', { name: /sign in/i })).toBeVisible();

  await bruno.goBack();
  await expect(bruno.getByRole('button', { name: /sign in/i })).toBeVisible();
  await expect(bruno.getByRole('heading', { name: /^loans$/i })).toHaveCount(0);
});

test('a page left open when an admin turns prices off keeps working, and gives nothing away', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  await createMini(olivia, 'Cheap');
  await createMini(olivia, 'Dear');
  const ids = (await apiCall<{ id: number; name: string }[]>(olivia, 'GET', '/api/minis')).body;
  // Prices set straight through the edit route, as their owner would.
  for (const [name, price] of [['Cheap', '1.00'], ['Dear', '99.00']] as const) {
    const id = ids.find(m => m.name === name)!.id;
    await olivia.evaluate(async ({ id, name, price }) => {
      const form = new FormData();
      form.append('name', name);
      form.append('price', price);
      await fetch(`/api/minis/${id}`, { method: 'PATCH', body: form, credentials: 'include' });
    }, { id, name, price });
  }

  // Bruno's page still offers "Price" — it loaded while prices were on.
  await bruno.goto('/');
  await expect(bruno.getByText('$99.00')).toBeVisible();

  const ada = await as('ada');
  await ada.goto('/');
  await apiCall(ada, 'POST', '/api/auth/select-collection', { collectionId: await groupId(ada, 'Chicago') });
  expect((await apiCall(ada, 'PATCH', '/api/admin/settings', { showPrices: false })).status).toBe(200);

  await bruno.getByLabel(/sort by/i).selectOption('price');
  await expect(bruno.getByText('Dear')).toBeVisible();
  await expect(bruno.getByText('$99.00')).toHaveCount(0);
  await expect(bruno.getByText('$1.00')).toHaveCount(0);
});
