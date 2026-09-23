import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import BulkAddPage from './BulkAddPage';
import { AuthContext } from '../App';
import { jsonResponse, urlOf } from '../test/apiMock';

// Adding a real shelf one mini at a time, three photos each, is what stops
// people finishing. This page takes the shelf in one go — a pile of photos, or
// a spreadsheet — and adds each row the same way the single form does.

function photo(name: string): File {
  return new File(['x'], name, { type: 'image/png' });
}

function renderPage() {
  return render(<MemoryRouter><BulkAddPage /></MemoryRouter>);
}

function row(n: number): HTMLElement {
  return screen.getByRole('region', { name: `Mini ${n}` });
}

async function pasteRows(text: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /paste from a spreadsheet/i }));
  await userEvent.click(screen.getByLabelText(/spreadsheet rows/i));
  await userEvent.paste(text);
  await userEvent.click(screen.getByRole('button', { name: /add these rows/i }));
}

// The minis the page sent, one POST each, in order.
function sentMinis(): FormData[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => urlOf(input) === '/api/minis' && init?.method === 'POST')
    .map(([, init]) => init!.body as FormData);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Mini added', miniId: 1 })));
});

describe('BulkAddPage — from photos', () => {
  it('makes one mini per photo, starting from the file\'s name when it says something', async () => {
    renderPage();

    await userEvent.upload(screen.getByTestId('image-input'), [photo('dire_wolf.png'), photo('IMG_0001.png')]);

    expect(await screen.findByRole('region', { name: 'Mini 2' })).toBeInTheDocument();
    expect(within(row(1)).getByLabelText(/^name/i)).toHaveValue('dire wolf');
    expect(within(row(2)).getByLabelText(/^name/i)).toHaveValue('');
    expect(within(row(1)).getAllByRole('img')).toHaveLength(1);
  });

  it('puts a photo with the mini above, for a mini shot from more than one side', async () => {
    renderPage();
    await userEvent.upload(screen.getByTestId('image-input'), [photo('dire_wolf.png'), photo('IMG_0002.png')]);

    await userEvent.click(within(await screen.findByRole('region', { name: 'Mini 2' })).getByRole('button', { name: /with the mini above/i }));

    expect(screen.queryByRole('region', { name: 'Mini 2' })).not.toBeInTheDocument();
    expect(within(row(1)).getAllByRole('img')).toHaveLength(2);
    expect(within(row(1)).getByLabelText(/^name/i)).toHaveValue('dire wolf');
  });

  it('sends each mini\'s photos with it', async () => {
    renderPage();
    await userEvent.upload(screen.getByTestId('image-input'), [photo('dire_wolf.png')]);

    await userEvent.click(await screen.findByRole('button', { name: /^add 1 mini$/i }));

    await waitFor(() => expect(sentMinis()).toHaveLength(1));
    expect(sentMinis()[0].get('name')).toBe('dire wolf');
    expect(sentMinis()[0].getAll('images')).toHaveLength(1);
  });

  it('removes a photo from a mini', async () => {
    renderPage();
    await userEvent.upload(screen.getByTestId('image-input'), [photo('dire_wolf.png')]);

    await userEvent.click(within(await screen.findByRole('region', { name: 'Mini 1' })).getByRole('button', { name: /remove photo 1/i }));

    expect(within(row(1)).queryAllByRole('img')).toHaveLength(0);
  });
});

describe('BulkAddPage — from a spreadsheet', () => {
  it('takes cells pasted straight from a spreadsheet', async () => {
    renderPage();

    await pasteRows('name\ttags\tprice\nDire Wolf\tundead, boss\t12.50\nOwlbear\t\t8');

    expect(within(row(1)).getByLabelText(/^name/i)).toHaveValue('Dire Wolf');
    expect(within(row(1)).getByLabelText(/^tags/i)).toHaveValue('undead, boss');
    expect(within(row(1)).getByLabelText(/^price/i)).toHaveValue('12.50');
    expect(within(row(2)).getByLabelText(/^name/i)).toHaveValue('Owlbear');
  });

  it('takes a CSV file', async () => {
    renderPage();

    await userEvent.upload(
      screen.getByLabelText(/choose a csv file/i),
      new File(['name,description\n"Wolf, Dire","Reaper, 28mm"'], 'shelf.csv', { type: 'text/csv' })
    );

    expect(await screen.findByRole('region', { name: 'Mini 1' })).toBeInTheDocument();
    expect(within(row(1)).getByLabelText(/^name/i)).toHaveValue('Wolf, Dire');
    expect(within(row(1)).getByLabelText(/^description/i)).toHaveValue('Reaper, 28mm');
  });

  // A page limit, not a server one — but one shelf too many is still a
  // hundred requests at a one-core Pi. A hundred rows is a big page for jsdom,
  // so this talks to the DOM directly (fireEvent, selectors) rather than
  // through userEvent and role queries, which each walk the whole
  // accessibility tree and take seconds apiece here.
  it('takes no more than 100 minis in one go, and says how many were left out', async () => {
    const { container } = renderPage();
    const lines = (count: number, from = 1) =>
      Array.from({ length: count }, (_, i) => `Mini number ${from + i}`).join('\n');
    const paste = (text: string) => {
      fireEvent.click(screen.getByText('Paste from a spreadsheet'));
      fireEvent.change(container.querySelector('#bulk-paste')!, { target: { value: text } });
      fireEvent.click(screen.getByText('Add these rows'));
    };
    const rowsOnPage = () => container.querySelectorAll('section[aria-label^="Mini "]').length;

    paste(`name\n${lines(105)}`);

    expect(await screen.findByText(/only 100 minis fit in one go, so 5 weren't added/i)).toBeInTheDocument();
    expect(rowsOnPage()).toBe(100);

    paste(`name\n${lines(3, 200)}`);

    expect(await screen.findByText(/so 3 weren't added/i)).toBeInTheDocument();
    expect(rowsOnPage()).toBe(100);
  }, 20000);

  it('says what it couldn\'t make sense of', async () => {
    renderPage();

    await pasteRows('Dire Wolf,12\nOwlbear,8');

    expect(await screen.findByText(/first row has to name the columns/i)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Mini 1' })).not.toBeInTheDocument();
  });
});

describe('BulkAddPage — a group with prices turned off', () => {
  function renderInGroupWithoutPrices() {
    return render(
      <MemoryRouter>
        <AuthContext.Provider value={{
          user: { userId: 1, username: 'owner', role: 'user', collectionId: 5 },
          loading: false, setUser: vi.fn(), selectCollection: vi.fn(), refreshSession: vi.fn(),
          collections: [{ id: 5, name: 'Chicago', role: 'user', showPrices: false }],
        }}>
          <BulkAddPage />
        </AuthContext.Provider>
      </MemoryRouter>
    );
  }

  it('has no price field, skips a price column (saying so), and sends no price', async () => {
    renderInGroupWithoutPrices();

    await pasteRows('name,price\nDire Wolf,12');

    expect(within(row(1)).queryByLabelText(/^price/i)).not.toBeInTheDocument();
    expect(screen.getByText(/ignored the "price" column/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^add 1 mini$/i }));

    expect(await screen.findByText(/added 1 mini/i)).toBeInTheDocument();
    expect(sentMinis()[0].has('price')).toBe(false);
  });
});

describe('BulkAddPage — adding them', () => {
  it('adds each mini in turn, with the tags meant for all of them, and clears the ones that were added', async () => {
    renderPage();
    await pasteRows('name,tags,price\nDire Wolf,undead,12\nOwlbear,,8');
    await userEvent.type(screen.getByLabelText(/tags for all of these/i), 'shelf 3');

    await userEvent.click(screen.getByRole('button', { name: /^add 2 minis$/i }));

    expect(await screen.findByText(/added 2 minis/i)).toBeInTheDocument();
    const [wolf, owlbear] = sentMinis();
    expect([wolf.get('name'), wolf.get('tags'), wolf.get('price')]).toEqual(['Dire Wolf', 'undead, shelf 3', '12']);
    expect([owlbear.get('name'), owlbear.get('tags'), owlbear.get('price')]).toEqual(['Owlbear', 'shelf 3', '8']);
    expect(owlbear.has('description')).toBe(false);
    expect(screen.queryByRole('region', { name: /^Mini/ })).not.toBeInTheDocument();
  });

  it('checks every row before sending any, and says what each one needs', async () => {
    renderPage();
    await pasteRows('name,price\nDire Wolf,12\n,8\nOwlbear,cheap');

    await userEvent.click(screen.getByRole('button', { name: /^add 3 minis$/i }));

    expect(await within(row(2)).findByText(/give this mini a name/i)).toBeInTheDocument();
    expect(within(row(3)).getByText(/enter a price like 12\.50/i)).toBeInTheDocument();
    expect(sentMinis()).toEqual([]);
  });

  it('keeps a mini the server refused, with its reason, and still adds the rest', async () => {
    let calls = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: '"wolf.png" isn\'t a photo we can open — use a JPG, PNG, GIF, or WebP' }, { ok: false })
        : jsonResponse({ message: 'Mini added', miniId: 2 });
    });
    renderPage();
    await pasteRows('name\nDire Wolf\nOwlbear');

    await userEvent.click(screen.getByRole('button', { name: /^add 2 minis$/i }));

    expect(await screen.findByText(/added 1 of 2/i)).toBeInTheDocument();
    expect(within(row(1)).getByLabelText(/^name/i)).toHaveValue('Dire Wolf');
    expect(within(row(1)).getByText(/isn't a photo we can open/i)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Mini 2' })).not.toBeInTheDocument();
  });

  it('can start a mini with no photo, to type in by hand', async () => {
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /add one without a photo/i }));
    await userEvent.type(within(row(1)).getByLabelText(/^name/i), 'Beholder');
    await userEvent.click(screen.getByRole('button', { name: /^add 1 mini$/i }));

    await waitFor(() => expect(sentMinis()).toHaveLength(1));
    expect(sentMinis()[0].get('name')).toBe('Beholder');
    expect(sentMinis()[0].getAll('images')).toEqual([]);
  });

  it('removes a mini from the list', async () => {
    renderPage();
    await pasteRows('name\nDire Wolf\nOwlbear');

    await userEvent.click(within(row(1)).getByRole('button', { name: /^remove$/i }));

    expect(within(row(1)).getByLabelText(/^name/i)).toHaveValue('Owlbear');
    expect(screen.queryByRole('region', { name: 'Mini 2' })).not.toBeInTheDocument();
  });

  it('has nothing to add until there is a row', () => {
    renderPage();

    expect(screen.queryByRole('button', { name: /^add \d+ minis?$/i })).not.toBeInTheDocument();
  });
});
