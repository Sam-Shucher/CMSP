import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MiniDetailModal from './components/MiniDetailModal';
import LoanCard from './components/LoanCard';
import CartPage from './pages/CartPage';
import AdminPage from './pages/AdminPage';
import { AuthContext } from './App';
import { Loan, Mini } from './api/client';
import { jsonResponse} from './test/apiMock';

// Anything another member typed — a mini name, a tag, a loan's "where", a
// display name — must show up as literal text, never become live markup that
// runs script in someone else's browser.
const XSS = '<img src=x onerror="window.__pwned = true">';
const SCRIPT = '<script>window.__pwned = true</script>';

function expectInert(container: HTMLElement): void {
  expect(container.querySelector('img[onerror]')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
  expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
}

beforeEach(() => {
  delete (window as unknown as { __pwned?: boolean }).__pwned;
});

describe('hostile text from other members renders as plain text', () => {
  it('in a mini\'s name, description, tags, and owner', () => {
    const mini: Mini = {
      id: 1, name: XSS, description: SCRIPT, images: [], price: 0, status: 'available', available: true,
      owner_name: XSS, owner_username: 'x', owner_id: 2, tags: [SCRIPT], created_at: '2026-01-01T00:00:00.000Z',
      set_id: null, set_name: null, condition: null, conditionSince: null,
    };
    const { container } = render(<MiniDetailModal mini={mini} onClose={vi.fn()} />);

    expect(screen.getAllByText(XSS, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(SCRIPT).length).toBeGreaterThan(0);
    expectInert(container);
  });

  it('in loan terms and the other person\'s name', () => {
    const loan: Loan = {
      id: 1, miniId: 1, miniName: XSS, miniImage: null, role: 'owner',
      counterpart: { id: 2, username: 'x', displayName: SCRIPT },
      status: 'adventuring', stage: 'adventuring', handoffWhen: null, handoffWhere: XSS, handoffHow: SCRIPT,
      durationDays: 7, borrowerApproved: true, ownerApproved: true, handedOffAt: null, receivedAt: null,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(), returnedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
      holdsWaiting: 0, extendableDays: 76, conditionReports: 0, openConditionPhases: [],
    };
    const { container } = render(<LoanCard loan={loan} now={new Date()} otherOpenRequests={0} onUpdated={vi.fn()} />);

    expect(screen.getByText(XSS)).toBeInTheDocument();
    expectInert(container);
  });

  it('in the cart', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      { miniId: 1, name: XSS, image: null, ownerId: 2, ownerName: SCRIPT, ownerUsername: 'x', status: 'available' },
    ])));
    const { container } = render(<MemoryRouter><CartPage /></MemoryRouter>);

    expect(await screen.findByText(XSS)).toBeInTheDocument();
    expectInert(container);
  });

  it('in the admin member and invite tables', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/admin/users'
      ? jsonResponse([{ id: 2, email: 'x@example.com', username: SCRIPT, display_name: XSS, phone: XSS, neighborhood: SCRIPT, role: 'user', created_at: '2026-01-01T00:00:00.000Z' }])
      : jsonResponse([{ id: 1, email: XSS, added_at: '2026-01-01T00:00:00.000Z', added_by_username: SCRIPT }])));
    const { container } = render(
      <AuthContext.Provider value={{ user: { userId: 1, username: 'boss', role: 'admin' }, loading: false, setUser: vi.fn(), collections: [], selectCollection: vi.fn(), refreshSession: vi.fn() }}>
        <AdminPage />
      </AuthContext.Provider>
    );

    expect((await screen.findAllByText(XSS)).length).toBeGreaterThan(0);
    expectInert(container);
  });
});
