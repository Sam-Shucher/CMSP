import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MiniDetailModal from './MiniDetailModal';
import { Mini } from '../api/client';

function makeMini(overrides: Partial<Mini> = {}): Mini {
  return {
    id: 1,
    name: 'Dire Wolf',
    description: 'A very long and detailed description of this fierce wolf mini.',
    images: [],
    price: 12.5,
    status: 'available',
    available: true,
    owner_name: 'Owner Name',
    owner_username: 'owner',
    owner_id: 1,
    tags: ['painted', 'boss'],
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('MiniDetailModal', () => {
  it('shows the full name, description, tags, owner, and price', () => {
    render(<MiniDetailModal mini={makeMini()} onClose={vi.fn()} />);

    expect(screen.getByText('Dire Wolf')).toBeInTheDocument();
    expect(screen.getByText(/very long and detailed description/i)).toBeInTheDocument();
    expect(screen.getByText('painted')).toBeInTheDocument();
    expect(screen.getByText('boss')).toBeInTheDocument();
    expect(screen.getByText(/owner name/i)).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
  });

  it('does not show next/prev arrows when there are 0 or 1 images', () => {
    render(<MiniDetailModal mini={makeMini({ images: ['/uploads/a.png'] })} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /next image/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /previous image/i })).not.toBeInTheDocument();
  });

  it('shows arrows and cycles through multiple images, wrapping at each end', () => {
    render(
      <MiniDetailModal
        mini={makeMini({ images: ['/uploads/a.png', '/uploads/b.png', '/uploads/c.png'] })}
        onClose={vi.fn()}
      />
    );

    const image = screen.getByRole('img', { name: /dire wolf/i });
    expect(image).toHaveAttribute('src', '/uploads/a.png');

    fireEvent.click(screen.getByRole('button', { name: /next image/i }));
    expect(image).toHaveAttribute('src', '/uploads/b.png');

    fireEvent.click(screen.getByRole('button', { name: /next image/i }));
    fireEvent.click(screen.getByRole('button', { name: /next image/i })); // wraps back to a.png
    expect(image).toHaveAttribute('src', '/uploads/a.png');

    fireEvent.click(screen.getByRole('button', { name: /previous image/i })); // wraps to c.png
    expect(image).toHaveAttribute('src', '/uploads/c.png');
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<MiniDetailModal mini={makeMini()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop is clicked, but not when the content is clicked', () => {
    const onClose = vi.fn();
    render(<MiniDetailModal mini={makeMini()} onClose={onClose} />);

    fireEvent.click(screen.getByText('Dire Wolf'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('mini-detail-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves between photos with the left and right arrow keys', () => {
    render(
      <MiniDetailModal
        mini={makeMini({ images: ['/uploads/a.png', '/uploads/b.png'] })}
        onClose={vi.fn()}
      />
    );
    const image = screen.getByRole('img', { name: /dire wolf/i });

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(image).toHaveAttribute('src', '/uploads/b.png');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(image).toHaveAttribute('src', '/uploads/a.png');
  });

  it('ignores arrow keys when there is only one photo', () => {
    render(<MiniDetailModal mini={makeMini({ images: ['/uploads/a.png'] })} onClose={vi.fn()} />);

    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(screen.getByRole('img', { name: /dire wolf/i })).toHaveAttribute('src', '/uploads/a.png');
  });

  it('stops listening for keys once closed', () => {
    const onClose = vi.fn();
    const { unmount } = render(<MiniDetailModal mini={makeMini()} onClose={onClose} />);
    unmount();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a placeholder when the mini has no photos, and no description block when there is none', () => {
    render(<MiniDetailModal mini={makeMini({ description: null, tags: [], price: 0 })} onClose={vi.fn()} />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('⚔')).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('does not show cart controls when no add-to-cart handler is given', () => {
    render(<MiniDetailModal mini={makeMini()} onClose={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /add to cart/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/this is your mini/i)).not.toBeInTheDocument();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<MiniDetailModal mini={makeMini()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MiniDetailModal — taking your own mini on a quest', () => {
  function renderOwn(mini: Mini, handlers: { onTakeOut?: ReturnType<typeof vi.fn>; onBringBack?: ReturnType<typeof vi.fn> } = {}) {
    const onTakeOut = handlers.onTakeOut ?? vi.fn().mockResolvedValue(undefined);
    const onBringBack = handlers.onBringBack ?? vi.fn().mockResolvedValue(undefined);
    render(
      <MiniDetailModal
        mini={mini} onClose={vi.fn()} isOwn inCart={false}
        onAddToCart={vi.fn()} onTakeOut={onTakeOut} onBringBack={onBringBack}
      />
    );
    return { onTakeOut, onBringBack };
  }

  it('lets the owner take an available mini on a quest in one click, no date needed', async () => {
    const { onTakeOut } = renderOwn(makeMini());

    fireEvent.click(screen.getByRole('button', { name: /take on a quest/i }));

    await waitFor(() => expect(onTakeOut).toHaveBeenCalledWith(null));
  });

  it('passes along an optional back-by date', async () => {
    const { onTakeOut } = renderOwn(makeMini());

    fireEvent.change(screen.getByLabelText(/back by/i), { target: { value: '2026-10-15' } });
    fireEvent.click(screen.getByRole('button', { name: /take on a quest/i }));

    await waitFor(() => expect(onTakeOut).toHaveBeenCalledWith('2026-10-15'));
  });

  it('does not offer back-by dates in the past', () => {
    renderOwn(makeMini());

    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(screen.getByLabelText(/back by/i)).toHaveAttribute(
      'min', `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
    );
  });

  it('shows when a questing mini is due back, and lets the owner bring it back', async () => {
    const { onBringBack } = renderOwn(makeMini({ status: 'on_quest', available: false, on_quest_since: '2026-10-01T18:00:00.000Z', on_quest_until: '2026-10-15' }));

    expect(screen.getByText(/back by oct 15/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /take on a quest/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /bring it back/i }));

    await waitFor(() => expect(onBringBack).toHaveBeenCalledTimes(1));
  });

  it('explains why it can\'t go on a quest while someone has requested it', () => {
    renderOwn(makeMini({ status: 'requested', available: false }));

    expect(screen.queryByRole('button', { name: /take on a quest/i })).not.toBeInTheDocument();
    expect(screen.getByText(/someone has requested this/i)).toBeInTheDocument();
  });

  it('explains why it can\'t go on a quest while a borrower has it', () => {
    renderOwn(makeMini({ status: 'adventuring', available: false }));

    expect(screen.queryByRole('button', { name: /take on a quest/i })).not.toBeInTheDocument();
    expect(screen.getByText(/out adventuring/i)).toBeInTheDocument();
  });

  it('shows the server\'s message if taking it out fails', async () => {
    renderOwn(makeMini(), { onTakeOut: vi.fn().mockRejectedValue(new Error('Someone has requested this mini — cancel or finish that request first')) });

    fireEvent.click(screen.getByRole('button', { name: /take on a quest/i }));

    expect(await screen.findByText(/cancel or finish that request first/i)).toBeInTheDocument();
  });

  it('never shows quest controls to someone who doesn\'t own the mini', () => {
    render(<MiniDetailModal mini={makeMini()} onClose={vi.fn()} isOwn={false} inCart={false} onAddToCart={vi.fn()} onTakeOut={vi.fn()} onBringBack={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /take on a quest/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/back by/i)).not.toBeInTheDocument();
  });

  it('tells other members it\'s on a quest with its owner, and when it\'s due back', () => {
    const onAddToCart = vi.fn();
    render(
      <MiniDetailModal
        mini={makeMini({ status: 'on_quest', available: false, on_quest_since: '2026-10-01T18:00:00.000Z', on_quest_until: '2026-10-15' })}
        onClose={vi.fn()} isOwn={false} inCart={false} onAddToCart={onAddToCart}
      />
    );

    const button = screen.getByRole('button', { name: /not available/i });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/on a quest with its owner/i);
    expect(button).toHaveTextContent(/back by oct 15/i);
    fireEvent.click(button);
    expect(onAddToCart).not.toHaveBeenCalled();
  });
});

describe('MiniDetailModal — adding to the cart', () => {
  it('offers "Add to cart" for someone else\'s available mini, and calls onAddToCart', async () => {
    const onAddToCart = vi.fn().mockResolvedValue(undefined);
    render(<MiniDetailModal mini={makeMini()} onClose={vi.fn()} isOwn={false} inCart={false} onAddToCart={onAddToCart} />);

    fireEvent.click(screen.getByRole('button', { name: /add to cart/i }));
    await waitFor(() => expect(onAddToCart).toHaveBeenCalledTimes(1));
  });

  it('shows it is already in your cart instead of offering to add it again', () => {
    render(<MiniDetailModal mini={makeMini()} onClose={vi.fn()} isOwn={false} inCart={true} onAddToCart={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /add to cart/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /in your cart/i })).toBeDisabled();
  });

  it('never offers your own mini', () => {
    render(<MiniDetailModal mini={makeMini()} onClose={vi.fn()} isOwn={true} inCart={false} onAddToCart={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /add to cart/i })).not.toBeInTheDocument();
    expect(screen.getByText(/this is your mini/i)).toBeInTheDocument();
  });

  it.each([
    ['requested', 'Requested'],
    ['adventuring', 'Adventuring'],
  ] as const)('blocks adding a %s mini and labels why', (status, label) => {
    const onAddToCart = vi.fn();
    render(
      <MiniDetailModal
        mini={makeMini({ status, available: false })}
        onClose={vi.fn()}
        isOwn={false}
        inCart={false}
        onAddToCart={onAddToCart}
      />
    );

    expect(screen.queryByRole('button', { name: /add to cart/i })).not.toBeInTheDocument();
    const unavailable = screen.getByRole('button', { name: /not available/i });
    expect(unavailable).toBeDisabled();
    fireEvent.click(unavailable);
    expect(onAddToCart).not.toHaveBeenCalled();
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it('disables the button while adding, so it can\'t be added twice', async () => {
    let finish!: () => void;
    const onAddToCart = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<MiniDetailModal mini={makeMini()} onClose={vi.fn()} isOwn={false} inCart={false} onAddToCart={onAddToCart} />);

    fireEvent.click(screen.getByRole('button', { name: /add to cart/i }));

    expect(await screen.findByRole('button', { name: /adding/i })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: /add to cart/i })).toBeEnabled());
  });

  it('shows the server\'s message if adding fails', async () => {
    const onAddToCart = vi.fn().mockRejectedValue(new Error("That mini isn't available right now"));
    render(<MiniDetailModal mini={makeMini()} onClose={vi.fn()} isOwn={false} inCart={false} onAddToCart={onAddToCart} />);

    fireEvent.click(screen.getByRole('button', { name: /add to cart/i }));
    expect(await screen.findByText(/isn't available right now/i)).toBeInTheDocument();
  });
});
