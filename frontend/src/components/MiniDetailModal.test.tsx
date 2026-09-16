import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MiniDetailModal from './MiniDetailModal';
import { Mini } from '../api/client';

function makeMini(overrides: Partial<Mini> = {}): Mini {
  return {
    id: 1,
    name: 'Dire Wolf',
    description: 'A very long and detailed description of this fierce wolf mini.',
    images: [],
    price: 12.5,
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

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<MiniDetailModal mini={makeMini()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
