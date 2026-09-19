import { test, expect, createMini, TINY_PNG, apiCall } from './support/fixtures';

// Adding, viewing, editing, taking on a quest, and deleting minis — including
// real photo uploads, which are only shown to members of the mini's group.

test('adding a mini with a photo, and other members seeing it', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');

  await olivia.goto('/');
  await olivia.getByRole('link', { name: 'Add Mini' }).first().click();
  await olivia.getByLabel(/Name/).fill('Tabaxi Bard');
  await olivia.getByLabel('Description').fill('Manufacturer: WizKids\nScale: 28mm\nSeries: Nolzur\'s');
  await olivia.getByLabel(/Tags/).fill('bard, painted');
  await olivia.getByLabel(/Price/).fill('12.50');
  await olivia.getByTestId('image-input').setInputFiles({ name: 'bard.png', mimeType: 'image/png', buffer: TINY_PNG });
  await olivia.getByRole('button', { name: 'Add to Collection' }).click();

  await expect(olivia.getByRole('heading', { name: 'The Collection' })).toBeVisible();
  await expect(olivia.getByText('Tabaxi Bard')).toBeVisible();

  // Bruno sees it, with a photo that actually loads (served only to members, under the site's security rules).
  await bruno.goto('/');
  const photo = bruno.getByRole('img', { name: 'Tabaxi Bard' });
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(bruno.getByText('$12.50')).toBeVisible();

  // The description only appears in the detail view.
  await expect(bruno.getByText('Scale: 28mm')).toHaveCount(0);
  await bruno.getByText('Tabaxi Bard').click();
  await expect(bruno.getByText(/Scale: 28mm/)).toBeVisible();
});

test('picking several phone photos at once, with a file that isn\'t really a photo among them', async ({ as }) => {
  const olivia = await as('olivia');
  await olivia.goto('/upload');

  // Real JPEGs, as a phone camera would make them (drawn in the browser).
  const photos = await olivia.evaluate(async () => {
    const make = async (hue: number) => {
      const canvas = new OffscreenCanvas(1600, 1200);
      const g = canvas.getContext('2d')!;
      g.fillStyle = `hsl(${hue}, 40%, 35%)`; g.fillRect(0, 0, 1600, 1200);
      g.fillStyle = '#d2b48c'; g.beginPath(); g.arc(800, 500, 200, 0, Math.PI * 2); g.fill();
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
      return Array.from(bytes);
    };
    return [await make(30), await make(200)];
  });

  await olivia.getByLabel(/Name/).fill('Owlbear');
  await olivia.getByLabel(/Price/).fill('12,50');
  await olivia.getByTestId('image-input').setInputFiles([
    { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(photos[0]) },
    { name: 'shopping list.png', mimeType: 'image/png', buffer: Buffer.from('eggs, milk, more paint') },
    { name: 'IMG_0002.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(photos[1]) },
  ]);

  await expect(olivia.getByText('"shopping list.png" doesn\'t look like a photo we can open.')).toBeVisible();
  await expect(olivia.getByRole('img', { name: 'Preview' })).toHaveCount(2);
  await olivia.getByRole('button', { name: 'Add to Collection' }).click();

  const bruno = await as('bruno');
  await bruno.goto('/');
  await expect(bruno.getByText('$12.50')).toBeVisible();
  await bruno.getByText('Owlbear').click();
  await expect(bruno.getByText('1 / 2')).toBeVisible();
});

test('searching tolerates typos and tags filter the list', async ({ as }) => {
  const olivia = await as('olivia');
  await createMini(olivia, 'Tabaxi Bard', { tags: 'bard' });
  await createMini(olivia, 'Goblin Grunt', { tags: 'goblin' });

  await olivia.goto('/');
  await olivia.getByPlaceholder(/Search/).fill('tabaxe');
  await expect(olivia.getByText('Tabaxi Bard')).toBeVisible();
  await expect(olivia.getByText('Goblin Grunt')).toHaveCount(0);

  await olivia.getByPlaceholder(/Search/).fill('');
  await olivia.getByRole('button', { name: 'goblin', exact: true }).click();
  await expect(olivia.getByText('Goblin Grunt')).toBeVisible();
  await expect(olivia.getByText('Tabaxi Bard')).toHaveCount(0);
});

test('only the owner can edit, and deleting needs the name typed exactly', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  await createMini(olivia, 'Dire Wolf');

  await bruno.goto('/');
  await expect(bruno.getByText('Dire Wolf')).toBeVisible();
  await expect(bruno.getByRole('link', { name: 'Edit' })).toHaveCount(0);

  await olivia.goto('/');
  await olivia.getByRole('link', { name: 'Edit' }).click();
  await olivia.getByLabel(/Name/).fill('Dire Wolf Alpha');
  await olivia.getByRole('button', { name: 'Save Changes' }).click();
  await expect(olivia.getByText('Dire Wolf Alpha')).toBeVisible();

  await olivia.getByRole('link', { name: 'Edit' }).click();
  await olivia.getByRole('button', { name: 'Delete Mini' }).click();
  const confirm = olivia.getByRole('button', { name: 'Confirm Delete' });
  await expect(confirm).toBeDisabled();
  await olivia.getByLabel(/Type/).fill('Dire Wolf');
  await expect(confirm).toBeDisabled();
  await olivia.getByLabel(/Type/).fill('Dire Wolf Alpha');
  await confirm.click();

  await expect(olivia.getByText('No minis found')).toBeVisible();
});

test('a mini that is requested can\'t be deleted, and the owner is told why', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  const miniId = await createMini(olivia, 'Dire Wolf');
  await apiCall(bruno, 'POST', '/api/cart', { miniId });
  await apiCall(bruno, 'POST', '/api/cart/checkout');

  await olivia.goto(`/minis/${miniId}/edit`);
  await olivia.getByRole('button', { name: 'Delete Mini' }).click();
  await olivia.getByLabel(/Type/).fill('Dire Wolf');
  await olivia.getByRole('button', { name: 'Confirm Delete' }).click();

  await expect(olivia.getByText(/active request or loan/)).toBeVisible();
});

// A quest is capped at three months. The date box says so and won't offer a
// later day; a typed-in later day is pulled back to the limit rather than sent.
test('a back-by date more than three months away is pulled back to the limit', async ({ as }) => {
  const olivia = await as('olivia');
  await createMini(olivia, 'Owlbear');

  const limit = new Date(Date.now() + 90 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const latest = `${limit.getFullYear()}-${pad(limit.getMonth() + 1)}-${pad(limit.getDate())}`;
  const shown = limit.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  await olivia.goto('/');
  await olivia.getByText('Owlbear').click();

  const backBy = olivia.getByLabel('Back by (optional)');
  await expect(backBy).toHaveAttribute('max', latest);
  await expect(olivia.getByText(/A quest can last up to 3 months/)).toBeVisible();

  await backBy.fill(`${new Date().getFullYear() + 3}-01-15`);
  await expect(backBy).toHaveValue(latest);
  await expect(olivia.getByText(/the latest it can be/)).toBeVisible();

  await olivia.getByRole('button', { name: 'Take on a quest' }).click();
  await expect(olivia.getByText(`On a quest with you · back by ${shown}`)).toBeVisible();
});

// …and the server doesn't take its word for it either.
test('the server refuses a back-by date past three months', async ({ as }) => {
  const olivia = await as('olivia');
  const miniId = await createMini(olivia, 'Owlbear Two');

  // Comfortably past the limit: the server counts its three months in UTC, so
  // a date only a day over can still be inside them from a timezone behind it.
  const tooFar = new Date(Date.now() + 120 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${tooFar.getFullYear()}-${pad(tooFar.getMonth() + 1)}-${pad(tooFar.getDate())}`;

  const res = await apiCall<{ error: string }>(olivia, 'POST', `/api/minis/${miniId}/take-out`, { backBy: day });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/3 months/);
});

test('taking your own mini on a quest and bringing it back', async ({ as }) => {
  const olivia = await as('olivia');
  const bruno = await as('bruno');
  await createMini(olivia, 'Beholder');

  // Two weeks out, as the date picker value and as it's shown ("Oct 15").
  const due = new Date(Date.now() + 14 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const backBy = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`;
  const shown = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  await olivia.goto('/');
  await olivia.getByText('Beholder').click();
  await olivia.getByLabel('Back by (optional)').fill(backBy);
  await olivia.getByRole('button', { name: 'Take on a quest' }).click();
  await expect(olivia.getByText(`On a quest with you · back by ${shown}`)).toBeVisible();

  await bruno.goto('/');
  await expect(bruno.locator('.badge-on_quest')).toHaveText('On a Quest');
  await bruno.getByText('Beholder').click();
  await expect(bruno.getByRole('button', { name: `Not available — on a quest with its owner (back by ${shown})` })).toBeDisabled();
  await expect(bruno.getByRole('button', { name: 'Add to cart' })).toHaveCount(0);

  await olivia.getByRole('button', { name: 'Bring it back' }).click();
  await expect(olivia.getByRole('button', { name: 'Take on a quest' })).toBeVisible();

  await bruno.reload();
  await bruno.getByText('Beholder').click();
  await expect(bruno.getByRole('button', { name: 'Add to cart' })).toBeEnabled();
});
