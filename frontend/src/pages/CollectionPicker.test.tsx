import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CollectionPicker from './CollectionPicker';

describe('CollectionPicker', () => {
  it('renders a button for each collection and calls onSelect with its id', async () => {
    const onSelect = vi.fn();
    render(
      <CollectionPicker
        collections={[{ id: 5, name: 'Chicago', role: 'user' }, { id: 6, name: 'dojo', role: 'user' }]}
        onSelect={onSelect}
      />
    );

    expect(screen.getByRole('button', { name: /chicago/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dojo/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /dojo/i }));
    expect(onSelect).toHaveBeenCalledWith(6);
  });

  it('shows the role you hold in each group before you enter it', () => {
    render(
      <CollectionPicker
        collections={[{ id: 5, name: 'Chicago', role: 'admin' }, { id: 6, name: 'dojo', role: 'user' }]}
        onSelect={vi.fn()}
      />
    );

    expect(within(screen.getByRole('button', { name: /chicago/i })).getByText('Admin')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /dojo/i })).getByText('Member')).toBeInTheDocument();
  });
});
