import { test, expect, apiCall } from './support/fixtures';
import { PASSWORD, emailOf, query } from './support/seed.cjs';

// Signing in and out, registering from an invite, groups and roles, and the
// admin panel — as real visitors would click through them.

test.describe('signing in', () => {
  test('points out a mistyped email politely, then signs in', async ({ guest }) => {
    const page = await guest();
    await page.goto('/login');
    const email = page.getByLabel('Email');

    await email.pressSequentially('bruno');
    await expect(page.getByRole('alert')).toHaveCount(0); // nothing while typing

    await page.getByLabel('Password').click(); // moving on to the password
    await expect(page.getByRole('alert')).toHaveText('Enter an email like name@example.com.');

    await email.fill(emailOf('bruno'));
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.getByRole('heading', { name: 'The Collection' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'bruno' })).toBeVisible();
  });

  test('explains a wrong password and stays on the sign-in page', async ({ guest }) => {
    const page = await guest();
    await page.goto('/login');
    await page.getByLabel('Email').fill(emailOf('bruno'));
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.getByText('Invalid email or password')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('sends visitors who aren\'t signed in to the sign-in page', async ({ guest }) => {
    const page = await guest();
    for (const path of ['/', '/loans', '/cart', '/admin']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
    }
  });
});

test.describe('groups and roles', () => {
  test('someone in two groups picks one, and sees the view for their role there', async ({ as }) => {
    const ada = await as('ada');
    await ada.goto('/');

    const chicago = ada.getByRole('button', { name: /^Chicago/ });
    await expect(chicago).toContainText('Admin');
    await expect(ada.getByRole('button', { name: /^dojo/ })).toContainText('Member');

    await chicago.click();
    await expect(ada.getByRole('link', { name: 'Admin' })).toBeVisible();

    await ada.getByRole('button', { name: 'Chicago (Switch)' }).click();
    await ada.getByRole('button', { name: /^dojo/ }).click();
    await expect(ada.getByRole('button', { name: 'dojo (Switch)' })).toBeVisible();
    await expect(ada.getByRole('link', { name: 'Admin' })).toHaveCount(0);

    await ada.goto('/admin');
    await expect(ada).toHaveURL(/\/$/); // not an admin in dojo
  });

  test('a tab left open on one group catches up after switching groups in another tab', async ({ as }) => {
    const tabA = await as('ada');
    await tabA.goto('/');
    await tabA.getByRole('button', { name: /^Chicago/ }).click();
    await tabA.goto('/upload');
    await tabA.getByLabel(/Name/).fill('Meant for Chicago');

    const tabB = await tabA.context().newPage();
    await tabB.goto('/');
    await tabB.getByRole('button', { name: 'Chicago (Switch)' }).click();
    await tabB.getByRole('button', { name: /^dojo/ }).click();
    await expect(tabB.getByRole('button', { name: 'dojo (Switch)' })).toBeVisible();

    // Tab A still shows Chicago. Saving must not quietly add the mini to dojo.
    await tabA.getByRole('button', { name: 'Add to Collection' }).click();
    await expect(tabA.getByRole('status')).toHaveText(/You switched to dojo in another tab, so this tab switched too\./);
    await expect(tabA.getByRole('button', { name: 'dojo (Switch)' })).toBeVisible();
    expect(await query("SELECT id FROM minis WHERE name = 'Meant for Chicago'")).toEqual([]);
  });

  test('a regular member can\'t reach the admin panel by typing its address', async ({ as }) => {
    const bruno = await as('bruno');
    await bruno.goto('/admin');

    await expect(bruno.getByRole('heading', { name: 'The Collection' })).toBeVisible();
    await expect(bruno).toHaveURL(/\/$/);
    expect((await apiCall(bruno, 'GET', '/api/admin/users')).status).toBe(403);
  });
});

test.describe('invites and registration', () => {
  test('an admin invites an email, and that person registers and lands in the group', async ({ as, guest }) => {
    const ada = await as('ada');
    await ada.goto('/');
    await ada.getByRole('button', { name: /^Chicago/ }).click();
    await ada.getByRole('link', { name: 'Admin' }).click();

    const inviteBox = ada.getByLabel('Email to invite');
    await inviteBox.fill('newfriend');
    await ada.getByRole('button', { name: 'Add Email' }).click();
    await expect(ada.getByRole('alert')).toHaveText('Enter an email like name@example.com.');

    await inviteBox.fill('newfriend@e2e.test');
    await ada.getByRole('button', { name: 'Add Email' }).click();
    await expect(ada.getByText('newfriend@e2e.test added to the invite list')).toBeVisible();

    const visitor = await guest();
    await visitor.goto('/register');
    await visitor.getByLabel(/^Email/).fill('newfriend@e2e.test');
    await visitor.getByLabel('Username').fill('new_friend');
    await visitor.getByLabel(/^Password$/).fill('a passphrase with spaces!');
    await visitor.getByLabel('Confirm Password').fill('a passphrase with spaces');
    await visitor.getByRole('button', { name: 'Create Account' }).click();
    await expect(visitor.getByText('Passwords don\'t match.')).toBeVisible();

    await visitor.getByLabel('Confirm Password').fill('a passphrase with spaces!');
    await visitor.getByRole('button', { name: 'Create Account' }).click();
    await expect(visitor.getByRole('heading', { name: 'The Collection' })).toBeVisible();
    await expect(visitor.getByText('Chicago', { exact: true })).toBeVisible();
  });

  // There's no email in this app: someone locked out asks an admin, who sets a
  // temporary password and passes it on — then the app insists on a new one.
  test('an admin resets a forgotten password, and the person chooses their own', async ({ as, guest }) => {
    const ada = await as('ada');
    await ada.goto('/');
    await ada.getByRole('button', { name: /^Chicago/ }).click();

    // Someone new, so this test doesn't disturb the other seeded people.
    await ada.goto('/admin');
    await ada.getByPlaceholder('friend@example.com').fill('forgetful@e2e.test');
    await ada.getByRole('button', { name: /Add Email/i }).click();
    await expect(ada.getByText(/forgetful@e2e.test added/i)).toBeVisible();

    const newcomer = await guest();
    await newcomer.goto('/register');
    await newcomer.getByLabel(/Email/).fill('forgetful@e2e.test');
    await newcomer.getByLabel('Username').fill('forgetful');
    await newcomer.getByLabel(/^Password$/).fill('the first password 1');
    await newcomer.getByLabel(/Confirm Password/).fill('the first password 1');
    await newcomer.getByRole('button', { name: 'Create Account' }).click();
    await expect(newcomer.getByRole('heading', { name: 'The Collection' })).toBeVisible();

    // They forget it. Ada resets, and reads the temporary one off her screen.
    await ada.reload();
    const row = ada.getByRole('row').filter({ hasText: 'forgetful' });
    await row.getByRole('button', { name: 'Reset password' }).click();
    await ada.getByLabel(/Type/).fill('forgetful');
    await ada.getByTestId('confirm-delete-modal').getByRole('button', { name: 'Reset password' }).click();
    const temporary = (await ada.getByTestId('temporary-password').innerText()).trim();
    expect(temporary).toMatch(/^[a-zA-Z0-9-]{16,}$/);
    await expect(ada.getByText(/only time it's shown/i)).toBeVisible();

    // Their old session is gone, and the old password no longer works.
    await newcomer.reload();
    await expect(newcomer.getByRole('button', { name: 'Sign In' })).toBeVisible();
    await newcomer.getByLabel('Email').fill('forgetful@e2e.test');
    await newcomer.getByLabel('Password').fill('the first password 1');
    await newcomer.getByRole('button', { name: 'Sign In' }).click();
    await expect(newcomer.getByText('Invalid email or password')).toBeVisible();

    // The temporary one gets them in, but no further until they choose a new one.
    await newcomer.getByLabel('Password').fill(temporary);
    await newcomer.getByRole('button', { name: 'Sign In' }).click();
    await expect(newcomer.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await expect(newcomer.getByRole('link', { name: 'Browse' })).toHaveCount(0);

    await newcomer.getByLabel('Current password').fill(temporary);
    await newcomer.getByLabel('New password', { exact: true }).fill('a second password 2');
    await newcomer.getByLabel('Confirm new password').fill('a second password 2');
    await newcomer.getByRole('button', { name: 'Change password' }).click();

    await expect(newcomer.getByRole('heading', { name: 'The Collection' })).toBeVisible();
  });

  test('an email that isn\'t invited can\'t register', async ({ guest }) => {
    const visitor = await guest();
    await visitor.goto('/register');
    await visitor.getByLabel(/^Email/).fill('stranger@e2e.test');
    await visitor.getByLabel('Username').fill('stranger');
    await visitor.getByLabel(/^Password$/).fill('long enough password');
    await visitor.getByLabel('Confirm Password').fill('long enough password');
    await visitor.getByRole('button', { name: 'Create Account' }).click();

    await expect(visitor.getByText(/not on the invite list/)).toBeVisible();
  });
});

test.describe('sessions', () => {
  test('"log out everywhere" signs out every device, which is told why', async ({ guest }) => {
    const phone = await guest();
    const laptop = await guest();
    for (const page of [phone, laptop]) {
      await page.goto('/login');
      await page.getByLabel('Email').fill(emailOf('sam'));
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign In' }).click();
      await expect(page.getByRole('heading', { name: 'The Collection' })).toBeVisible();
    }

    await laptop.getByRole('link', { name: 'sam' }).click();
    await laptop.getByRole('button', { name: 'Log out everywhere' }).click();
    await laptop.getByRole('button', { name: 'Yes, log out everywhere' }).click();
    await expect(laptop).toHaveURL(/\/login$/);

    // The phone's next action finds its session gone.
    await phone.getByRole('link', { name: 'Loans', exact: true }).click();
    await expect(phone.getByText('Your session has ended. Please sign in again.')).toBeVisible();
    await expect(phone).toHaveURL(/\/login$/);

    const [{ live }] = await query(
      "SELECT COUNT(*) AS live FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = 'sam' AND s.revoked_at IS NULL"
    ) as { live: number }[];
    expect(Number(live)).toBe(0);
  });

  test('signing out from the nav ends the session', async ({ guest }) => {
    const page = await guest();
    await page.goto('/login');
    await page.getByLabel('Email').fill(emailOf('theo'));
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page.getByRole('heading', { name: 'The Collection' })).toBeVisible();

    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/loans');
    await expect(page).toHaveURL(/\/login$/);
  });
});
