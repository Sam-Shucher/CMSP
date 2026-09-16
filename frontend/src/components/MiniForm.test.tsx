import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MiniForm from './MiniForm';

const EMPTY_VALUES = { name: '', description: '', tags: '', price: '' };

describe('MiniForm', () => {
  it('prefills fields from initialValues', () => {
    render(
      <MiniForm
        initialValues={{ name: 'Dire Wolf', description: 'A wolf', tags: 'dragon,painted', price: '12.50' }}
        submitLabel="Save"
        submittingLabel="Saving…"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/name/i)).toHaveValue('Dire Wolf');
    expect(screen.getByLabelText(/description/i)).toHaveValue('A wolf');
    expect(screen.getByLabelText(/tags/i)).toHaveValue('dragon,painted');
    expect(screen.getByLabelText(/price/i)).toHaveValue(12.5);
  });

  it('submits trimmed values when the form is valid', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <MiniForm
        initialValues={EMPTY_VALUES}
        submitLabel="Save"
        submittingLabel="Saving…"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/name/i), '  Beholder  ');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Beholder' }),
      [],
      []
    );
  });

  it('prefills existing images and includes them as kept images on submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <MiniForm
        initialValues={{ ...EMPTY_VALUES, name: 'Dire Wolf' }}
        initialImages={['/uploads/a.png']}
        submitLabel="Save"
        submittingLabel="Saving…"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByRole('img', { name: /mini/i })).toHaveAttribute('src', '/uploads/a.png');

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.anything(), [], ['/uploads/a.png']);
  });

  it('rejects a blank name and does not call onSubmit', async () => {
    const onSubmit = vi.fn();
    render(
      <MiniForm
        initialValues={EMPTY_VALUES}
        submitLabel="Save"
        submittingLabel="Saving…"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('enables the browser spell checker on the description and tags fields', () => {
    render(
      <MiniForm
        initialValues={EMPTY_VALUES}
        submitLabel="Save"
        submittingLabel="Saving…"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/description/i)).toHaveAttribute('spellcheck', 'true');
    expect(screen.getByLabelText(/tags/i)).toHaveAttribute('spellcheck', 'true');
  });

  it('rejects a negative price and does not call onSubmit', async () => {
    const onSubmit = vi.fn();
    render(
      <MiniForm
        initialValues={EMPTY_VALUES}
        submitLabel="Save"
        submittingLabel="Saving…"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/name/i), 'Beholder');
    await user.type(screen.getByLabelText(/price/i), '-5');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText(/price must be a non-negative number/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
