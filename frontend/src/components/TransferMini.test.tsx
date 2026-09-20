import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TransferMini from './TransferMini';
import { MiniOwner } from '../api/client';
import { jsonResponse, urlOf, jsonBodyOf } from '../test/apiMock';

function member(overrides: Partial<MiniOwner> = {}): MiniOwner {
  return { id: 2, name: 'Nadia Newowner', ...overrides };
}

describe('TransferMini', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('starts collapsed, and fetches nothing until asked', () => {
    render(<TransferMini miniId={42} miniName="Dire Wolf" ownerId={1} onTransferred={vi.fn()} />);

    expect(screen.getByRole('button', { name: /transfer ownership/i })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches the member list when opened, excluding the current owner', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([
      { id: 1, name: 'Olivia Owner' }, member(),
    ]));

    render(<TransferMini miniId={42} miniName="Dire Wolf" ownerId={1} onTransferred={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^transfer ownership$/i }));

    expect(urlOf(vi.mocked(fetch).mock.calls[0][0])).toBe('/api/minis/collection-members');
    const select = await screen.findByLabelText(/give to/i);
    expect(within(select).queryByRole('option', { name: 'Olivia Owner' })).not.toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Nadia Newowner' })).toBeInTheDocument();
  });

  it('says so plainly when there\'s nobody else to give it to', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([{ id: 1, name: 'Olivia Owner' }]));

    render(<TransferMini miniId={42} miniName="Dire Wolf" ownerId={1} onTransferred={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^transfer ownership$/i }));

    expect(await screen.findByText(/nobody else in this collection/i)).toBeInTheDocument();
  });

  it('disables Transfer until a member is chosen', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([member()]));

    render(<TransferMini miniId={42} miniName="Dire Wolf" ownerId={1} onTransferred={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^transfer ownership$/i }));
    await screen.findByLabelText(/give to/i);

    expect(screen.getByRole('button', { name: /^transfer$/i })).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText(/give to/i), '2');
    expect(screen.getByRole('button', { name: /^transfer$/i })).toBeEnabled();
  });

  it('requires confirming with the recipient\'s name before transferring', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([member()]))
      .mockResolvedValueOnce(jsonResponse({ id: 42, name: 'Dire Wolf', owner_id: 2 }));
    const onTransferred = vi.fn();

    render(<TransferMini miniId={42} miniName="Dire Wolf" ownerId={1} onTransferred={onTransferred} />);
    await userEvent.click(screen.getByRole('button', { name: /^transfer ownership$/i }));
    await userEvent.selectOptions(await screen.findByLabelText(/give to/i), '2');
    await userEvent.click(screen.getByRole('button', { name: /^transfer$/i }));

    const confirmButton = await screen.findByRole('button', { name: /^confirm transfer$/i });
    expect(confirmButton).toBeDisabled();
    expect(onTransferred).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/type/i), 'Nadia Newowner');
    await userEvent.click(confirmButton);

    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('/api/minis/42/transfer');
    expect(jsonBodyOf(vi.mocked(fetch).mock.calls[1][1])).toEqual({ newOwnerId: 2 });
    expect(onTransferred).toHaveBeenCalledWith(expect.objectContaining({ owner_id: 2 }));
  });

  it('does not transfer anything if the confirm modal is cancelled', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([member()]));

    render(<TransferMini miniId={42} miniName="Dire Wolf" ownerId={1} onTransferred={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^transfer ownership$/i }));
    await userEvent.selectOptions(await screen.findByLabelText(/give to/i), '2');
    await userEvent.click(screen.getByRole('button', { name: /^transfer$/i }));

    const modal = await screen.findByTestId('confirm-delete-modal');
    await userEvent.click(within(modal).getByRole('button', { name: /cancel/i }));

    expect(screen.queryByTestId('confirm-delete-modal')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1); // only the member-list fetch
  });

  it('shows the server\'s refusal (e.g. an active loan) instead of pretending it worked', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([member()]))
      .mockResolvedValueOnce(jsonResponse(
        { error: 'This mini has an active request or loan — finish or cancel it first' }, { ok: false, status: 409 }
      ));
    const onTransferred = vi.fn();

    render(<TransferMini miniId={42} miniName="Dire Wolf" ownerId={1} onTransferred={onTransferred} />);
    await userEvent.click(screen.getByRole('button', { name: /^transfer ownership$/i }));
    await userEvent.selectOptions(await screen.findByLabelText(/give to/i), '2');
    await userEvent.click(screen.getByRole('button', { name: /^transfer$/i }));
    await userEvent.type(await screen.findByLabelText(/type/i), 'Nadia Newowner');
    await userEvent.click(screen.getByRole('button', { name: /^confirm transfer$/i }));

    expect(await screen.findByText(/has an active request or loan/i)).toBeInTheDocument();
    expect(screen.queryByTestId('confirm-delete-modal')).not.toBeInTheDocument();
    expect(onTransferred).not.toHaveBeenCalled();
  });

  it('collapses again without re-fetching the member list a second time', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([member()]));

    render(<TransferMini miniId={42} miniName="Dire Wolf" ownerId={1} onTransferred={vi.fn()} />);
    const button = screen.getByRole('button', { name: /^transfer ownership$/i });
    await userEvent.click(button);
    await screen.findByLabelText(/give to/i);

    await userEvent.click(screen.getByRole('button', { name: /hide transfer ownership/i }));
    expect(screen.queryByLabelText(/give to/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^transfer ownership$/i }));
    expect(await screen.findByLabelText(/give to/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shows the server\'s message if the member list can\'t be loaded', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: 'Server error' }, { ok: false, status: 500 }));

    render(<TransferMini miniId={42} miniName="Dire Wolf" ownerId={1} onTransferred={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^transfer ownership$/i }));

    expect(await screen.findByText('Server error')).toBeInTheDocument();
  });
});
