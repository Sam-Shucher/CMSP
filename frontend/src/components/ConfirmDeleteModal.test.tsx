import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmDeleteModal from './ConfirmDeleteModal';

describe('ConfirmDeleteModal', () => {
  it('keeps the delete button disabled until the exact phrase is typed', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDeleteModal
        title="Remove email"
        description="This will remove the email from the invite list."
        confirmPhrase="friend@example.com"
        confirmButtonLabel="Delete"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );

    const deleteButton = screen.getByRole('button', { name: /^delete$/i });
    expect(deleteButton).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/type/i), 'not the right thing');
    expect(deleteButton).toBeDisabled();

    await user.click(deleteButton);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('enables the delete button once the exact phrase is typed, and confirms on click', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDeleteModal
        title="Delete user"
        description="This permanently deletes the account."
        confirmPhrase="grunt"
        confirmButtonLabel="Delete User"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/type/i), 'grunt');

    const deleteButton = screen.getByRole('button', { name: /delete user/i });
    expect(deleteButton).toBeEnabled();

    await user.click(deleteButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteModal
        title="Delete user"
        description="This permanently deletes the account."
        confirmPhrase="grunt"
        confirmButtonLabel="Delete User"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
