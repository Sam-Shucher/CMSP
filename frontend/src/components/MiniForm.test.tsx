import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
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

    expect(await screen.findByText('Give your mini a name.')).toBeInTheDocument();
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

  it('shows the error from a failed save and re-enables the button', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('You can only edit your own minis'));
    render(
      <MiniForm
        initialValues={{ ...EMPTY_VALUES, name: 'Dire Wolf' }}
        submitLabel="Save"
        submittingLabel="Saving…"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('You can only edit your own minis')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });

  it('shows the submitting label and blocks double submits while saving', async () => {
    let finish!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    render(
      <MiniForm
        initialValues={{ ...EMPTY_VALUES, name: 'Dire Wolf' }}
        submitLabel="Save"
        submittingLabel="Saving…"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    const saving = screen.getByRole('button', { name: /saving/i });
    expect(saving).toBeDisabled();
    await userEvent.click(saving);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
  });

  it('passes newly added photos and the remaining kept photos to onSubmit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <MiniForm
        initialValues={{ ...EMPTY_VALUES, name: 'Dire Wolf' }}
        initialImages={['/uploads/a.png', '/uploads/b.png']}
        submitLabel="Save"
        submittingLabel="Saving…"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    await userEvent.click(screen.getAllByRole('button', { name: /^remove$/i })[0]);
    const file = new File(['x'], 'new.png', { type: 'image/png' });
    await userEvent.upload(screen.getByTestId('image-input'), file);
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.anything(), [file], ['/uploads/b.png']));
  });

  it('calls onCancel without submitting', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <MiniForm
        initialValues={{ ...EMPTY_VALUES, name: 'Dire Wolf' }}
        submitLabel="Save"
        submittingLabel="Saving…"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric price', async () => {
    const onSubmit = vi.fn();
    render(
      <MiniForm
        initialValues={{ ...EMPTY_VALUES, name: 'Dire Wolf', price: 'free' }}
        submitLabel="Save"
        submittingLabel="Saving…"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Enter a price like 12.50, or leave it blank.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('limits field lengths to what the server accepts', () => {
    render(
      <MiniForm initialValues={EMPTY_VALUES} submitLabel="Save" submittingLabel="Saving…" onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    expect(screen.getByLabelText(/name/i)).toHaveAttribute('maxLength', '255');
    expect(screen.getByLabelText(/description/i)).toHaveAttribute('maxLength', '5000');
    expect(screen.getByLabelText(/price/i)).toHaveAttribute('max', '9999.99');
  });

  it('rejects a price above 9999.99 before sending', async () => {
    const onSubmit = vi.fn();
    render(
      <MiniForm
        initialValues={{ ...EMPTY_VALUES, name: 'Dire Wolf', price: '10000' }}
        submitLabel="Save"
        submittingLabel="Saving…"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Price must be 9999.99 or less.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects more than 20 tags or a tag over 50 characters before sending', async () => {
    const onSubmit = vi.fn();
    const { unmount } = render(
      <MiniForm
        initialValues={{ ...EMPTY_VALUES, name: 'Dire Wolf', tags: Array.from({ length: 21 }, (_, i) => `t${i}`).join(',') }}
        submitLabel="Save" submittingLabel="Saving…" onSubmit={onSubmit} onCancel={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText('Use 20 tags or fewer.')).toBeInTheDocument();
    unmount();

    render(
      <MiniForm
        initialValues={{ ...EMPTY_VALUES, name: 'Dire Wolf', tags: 'x'.repeat(51) }}
        submitLabel="Save" submittingLabel="Saving…" onSubmit={onSubmit} onCancel={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText('Keep each tag to 50 characters or fewer.')).toBeInTheDocument();

    expect(onSubmit).not.toHaveBeenCalled();
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

    expect(await screen.findByText('Price can\'t be negative.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('MiniForm — when problems are pointed out', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const renderForm = (values = EMPTY_VALUES) => render(
    <MiniForm initialValues={values} submitLabel="Save" submittingLabel="Saving…" onSubmit={vi.fn()} onCancel={vi.fn()} />
  );
  const errorUnder = (label: RegExp) =>
    document.getElementById(screen.getByLabelText(label).getAttribute('aria-describedby')!);

  it('says nothing about the price while you type, then explains after a 3-second pause', () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(/price/i), { target: { value: '-5' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(3000); });
    expect(errorUnder(/price/i)).toHaveTextContent('Price can\'t be negative.');
  });

  it('explains a tag problem under the tags field when you leave it', () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(/tags/i), { target: { value: 'x'.repeat(51) } });
    fireEvent.blur(screen.getByLabelText(/tags/i));

    expect(errorUnder(/tags/i)).toHaveTextContent('Keep each tag to 50 characters or fewer.');
  });

  it('shows the name problem under the name field on save', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(errorUnder(/name/i)).toHaveTextContent('Give your mini a name.');
    expect(screen.getByLabelText(/name/i)).toHaveAttribute('aria-invalid', 'true');
  });
});
