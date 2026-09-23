import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConditionReports from './ConditionReports';
import { ConditionReport } from '../api/client';
import { jsonResponse, urlOf } from '../test/apiMock';

// "The spear was already bent" — the record both sides can point at. The
// panel stays shut until someone asks for it, because most loans never need it.

const HANDOFF: ConditionReport = {
  id: 1, phase: 'handoff', authorId: 9, authorName: 'Olivia Owner',
  note: 'Spear straight, base a bit scuffed', photos: ['/uploads/a.jpg'],
  createdAt: '2026-10-01T18:05:00.000Z',
};

const RETURN: ConditionReport = {
  id: 2, phase: 'return', authorId: 4, authorName: 'Bruno Borrower',
  note: null, photos: ['/uploads/b.jpg', '/uploads/c.jpg'],
  createdAt: '2026-10-14T09:00:00.000Z',
};

function mockApi(reports: ConditionReport[], actions: Record<string, () => Response> = {}) {
  const saved: RequestInit[] = [];
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${urlOf(input)}`;
    if (actions[key]) {
      saved.push(init!);
      return actions[key]();
    }
    if (key === 'GET /api/loans/5/condition') return jsonResponse(reports);
    return jsonResponse({ error: `unexpected ${key}` }, { ok: false });
  });
  return saved;
}

function renderPanel(props: Partial<React.ComponentProps<typeof ConditionReports>> = {}) {
  return render(
    <ConditionReports
      loanId={5}
      reportCount={0}
      openPhases={['handoff', 'return']}
      onRecorded={vi.fn()}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

describe('ConditionReports', () => {
  it('stays shut until asked, and fetches nothing before then', () => {
    mockApi([]);
    renderPanel({ reportCount: 2 });

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /condition notes \(2\)/i })).toBeInTheDocument();
  });

  it('invites the first note when there are none yet', () => {
    mockApi([]);
    renderPanel();

    expect(screen.getByRole('button', { name: /record how it looks/i })).toBeInTheDocument();
  });

  it('shows both sides\' notes, whose they are, and which end they are about', async () => {
    mockApi([HANDOFF, RETURN]);
    renderPanel({ reportCount: 2 });

    await userEvent.click(screen.getByRole('button', { name: /condition notes/i }));

    const list = await screen.findByRole('list', { name: /condition notes/i });
    expect(list).toHaveTextContent('Olivia Owner');
    expect(list).toHaveTextContent('At the handoff');
    expect(list).toHaveTextContent('Spear straight, base a bit scuffed');
    expect(list).toHaveTextContent('Bruno Borrower');
    expect(list).toHaveTextContent('At the return');
  });

  it('shows each note\'s photos', async () => {
    mockApi([HANDOFF, RETURN]);
    renderPanel({ reportCount: 2 });

    await userEvent.click(screen.getByRole('button', { name: /condition notes/i }));

    await screen.findByRole('list', { name: /condition notes/i });
    const photos = screen.getAllByRole('img');
    expect(photos.map(img => img.getAttribute('src'))).toEqual(['/uploads/a.jpg', '/uploads/b.jpg', '/uploads/c.jpg']);
  });

  it('records a note for the end you pick, as multipart so a photo can ride along', async () => {
    const saved = mockApi([], {
      'POST /api/loans/5/condition': () => jsonResponse([HANDOFF]),
    });
    const onRecorded = vi.fn();
    renderPanel({ onRecorded });

    await userEvent.click(screen.getByRole('button', { name: /record how it looks/i }));
    await userEvent.selectOptions(await screen.findByLabelText(/which end/i), 'handoff');
    await userEvent.type(screen.getByLabelText(/note/i), 'Spear was already bent');
    await userEvent.click(screen.getByRole('button', { name: /^record$/i }));

    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    const body = saved[0].body as FormData;
    expect(body.get('phase')).toBe('handoff');
    expect(body.get('note')).toBe('Spear was already bent');
  });

  it('only offers the ends that are still open', async () => {
    mockApi([]);
    renderPanel({ openPhases: ['return'] });

    await userEvent.click(screen.getByRole('button', { name: /record how it looks/i }));

    const picker = await screen.findByLabelText(/which end/i);
    expect(within(picker).queryByRole('option', { name: /handoff/i })).not.toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: /return/i })).toBeInTheDocument();
  });

  // Once the loan is over and nothing can be added, there's nothing to offer.
  it('offers no form at all when both ends are closed', async () => {
    mockApi([HANDOFF]);
    renderPanel({ openPhases: [], reportCount: 1 });

    await userEvent.click(screen.getByRole('button', { name: /condition notes/i }));

    await screen.findByRole('list', { name: /condition notes/i });
    expect(screen.queryByLabelText(/which end/i)).not.toBeInTheDocument();
  });

  it('will not send an empty report', async () => {
    mockApi([]);
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /record how it looks/i }));
    await screen.findByLabelText(/which end/i);

    expect(screen.getByRole('button', { name: /^record$/i })).toBeDisabled();
  });

  it('shows the server\'s reason when a report is refused', async () => {
    mockApi([], {
      'POST /api/loans/5/condition': () =>
        jsonResponse({ error: 'You already recorded how it looked at the handoff' }, { ok: false, status: 409 }),
    });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /record how it looks/i }));
    await userEvent.type(await screen.findByLabelText(/note/i), 'Again');
    await userEvent.click(screen.getByRole('button', { name: /^record$/i }));

    expect(await screen.findByText(/already recorded/i)).toBeInTheDocument();
  });
});
