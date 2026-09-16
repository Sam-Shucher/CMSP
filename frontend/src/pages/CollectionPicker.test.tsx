import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CollectionPicker from './CollectionPicker';

describe('CollectionPicker', () => {
  it('renders a button for each collection and calls onSelect with its id', async () => {
    const onSelect = vi.fn();
    render(
      <CollectionPicker
        collections={[{ id: 5, name: 'Chicago' }, { id: 6, name: 'dojo' }]}
        onSelect={onSelect}
      />
    );

    expect(screen.getByRole('button', { name: 'Chicago' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'dojo' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'dojo' }));
    expect(onSelect).toHaveBeenCalledWith(6);
  });
});
