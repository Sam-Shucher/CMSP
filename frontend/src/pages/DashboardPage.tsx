import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api, Mini, MiniOwner, CartItem, CART_CHANGED_EVENT } from '../api/client';
import { useAuth, useShowPrices } from '../App';
import MiniDetailModal from '../components/MiniDetailModal';
import MiniStatusBadge from '../components/MiniStatusBadge';
import { LIMITS, PAGE_SIZE } from '../limits';

// Long enough to swallow a burst of typing, short enough not to feel laggy.
export const SEARCH_DEBOUNCE_MS = 250;

type SortOption = 'newest' | 'name' | 'price';

// The main browse page — shows a searchable, filterable grid of all minis.
export default function DashboardPage(): React.ReactElement {
  const { user } = useAuth();
  const showPrices = useShowPrices();
  const [cartMiniIds, setCartMiniIds] = useState<Set<number>>(new Set());
  const [minis, setMinis]         = useState<Mini[]>([]);
  const [tags, setTags]           = useState<string[]>([]);  // all tags for the filter bar
  const [owners, setOwners]       = useState<MiniOwner[]>([]); // all owners for the owner filter
  const [search, setSearch]       = useState<string>('');    // what's in the box
  const [query, setQuery]         = useState<string>('');    // what's been asked of the server
  const [activeTag, setActiveTag] = useState<string>('');    // currently selected tag filter
  const [ownerId, setOwnerId]     = useState<string>('');    // currently selected owner filter ('' = all)
  const [sort, setSort]           = useState<SortOption>('newest');
  const [availableOnly, setAvailableOnly] = useState<boolean>(false);
  const [loading, setLoading]     = useState<boolean>(true);
  const [hasMore, setHasMore]     = useState<boolean>(false); // the last page was a full one
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError]         = useState<string>('');
  // Bumped whenever the filters change, so a page that arrives for the old
  // filters (slow phone connection, "Load more" still in flight) is dropped
  // instead of mixed into the new list.
  const listVersion = useRef<number>(0);
  const [selectedMini, setSelectedMini] = useState<Mini | null>(null);

  // Fetches minis from the API, passing any active search or tag filter as query params.
  // Wrapped in useCallback so that useEffect only re-runs when search or activeTag actually change.
  // Searching reads the whole collection and fuzzy-matches it on the Pi's one
  // core, so it waits for a break in the typing rather than going once per
  // keystroke ("owlbear beholder" was 17 requests, and 17 full scans).
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // The search and filters as a query string; a later page adds after=<id>.
  const browseQuery = useCallback((): URLSearchParams => {
    const params = new URLSearchParams();
    if (query)          params.set('q', query);
    if (activeTag)      params.set('tag', activeTag);
    if (ownerId)        params.set('owner', ownerId);
    if (sort !== 'newest') params.set('sort', sort);
    if (availableOnly) params.set('available', '1');
    return params;
  }, [query, activeTag, ownerId, sort, availableOnly]);

  // The first page for the current search and filters.
  const fetchMinis = useCallback(async (): Promise<void> => {
    const version = ++listVersion.current;
    setLoading(true);
    setError('');
    try {
      const data = await api<Mini[]>(`/api/minis?${browseQuery().toString()}`);
      if (version !== listVersion.current) return;
      setMinis(data);
      setHasMore(data.length >= PAGE_SIZE.browsePage);
    } catch (err: unknown) {
      if (version !== listVersion.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load minis');
    } finally {
      if (version === listVersion.current) setLoading(false);
    }
  }, [browseQuery]);

  // The next page, carrying on after the last mini shown — the server works
  // out where that is in the chosen order.
  async function loadMore(): Promise<void> {
    if (minis.length === 0) return;
    const last = minis[minis.length - 1];
    const version = listVersion.current;
    setLoadingMore(true);
    setError('');
    try {
      const params = browseQuery();
      params.set('after', String(last.id));
      const data = await api<Mini[]>(`/api/minis?${params.toString()}`);
      if (version !== listVersion.current) return;
      // A mini can move between pages (its price edited meanwhile); show it once.
      setMinis((prev: Mini[]) => {
        const shown = new Set(prev.map((m: Mini) => m.id));
        return [...prev, ...data.filter((m: Mini) => !shown.has(m.id))];
      });
      setHasMore(data.length >= PAGE_SIZE.browsePage);
    } catch (err: unknown) {
      if (version !== listVersion.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load more minis');
    } finally {
      setLoadingMore(false);
    }
  }

  // Re-fetch whenever the search text or active tag changes
  useEffect(() => {
    void fetchMinis();
  }, [fetchMinis]);

  // Load the tag list once on mount — used to render the filter buttons
  useEffect(() => {
    void api<string[]>('/api/minis/tags').then(setTags).catch(() => {});
  }, []);

  // Load the owner list once on mount — used to render the owner filter
  useEffect(() => {
    void api<MiniOwner[]>('/api/minis/owners').then(setOwners).catch(() => {});
  }, []);

  const fetchCart = useCallback(async (): Promise<void> => {
    try {
      const items = await api<CartItem[]>('/api/cart');
      setCartMiniIds(new Set(items.map((item: CartItem) => item.miniId)));
    } catch {
      // Non-fatal: the overlay just won't know what's already in the cart.
    }
  }, []);

  useEffect(() => {
    void fetchCart();
  }, [fetchCart]);

  async function addToCart(miniId: number): Promise<void> {
    await api('/api/cart', { method: 'POST', json: { miniId } });
    await fetchCart();
    window.dispatchEvent(new Event(CART_CHANGED_EVENT)); // the count in the nav
  }

  // Swap in the server's updated copy of a mini, both on its card and in the
  // open detail view, so the new status shows immediately.
  function replaceMini(updated: Mini): void {
    setMinis((prev: Mini[]) => prev.map((m: Mini) => (m.id === updated.id ? updated : m)));
    setSelectedMini((prev: Mini | null) => (prev?.id === updated.id ? updated : prev));
  }

  async function takeOnQuest(miniId: number, backBy: string | null): Promise<void> {
    replaceMini(await api<Mini>(`/api/minis/${miniId}/take-out`, { method: 'POST', json: { backBy } }));
  }

  async function bringBack(miniId: number): Promise<void> {
    replaceMini(await api<Mini>(`/api/minis/${miniId}/bring-back`, { method: 'POST' }));
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '22px', color: '#c9a84c', marginRight: 'auto' }}>The Collection</h2>
        <Link to="/upload">
          <button className="btn-primary">+ Add Mini</button>
        </Link>
      </div>

      {/* Search bar, plus sort/owner/available-only filters */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{ maxWidth: '360px' }}
          type="search"
          placeholder="Search by name or description…"
          maxLength={LIMITS.search}
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
        />

        <select
          aria-label="Sort by"
          value={sort}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSort(e.target.value as SortOption)}
        >
          <option value="newest">Newest</option>
          <option value="name">Name</option>
          {showPrices && <option value="price">Price</option>}
        </select>

        <select
          aria-label="Owner"
          value={ownerId}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setOwnerId(e.target.value)}
        >
          <option value="">All owners</option>
          {owners.map((owner: MiniOwner) => (
            <option key={owner.id} value={owner.id}>{owner.name}</option>
          ))}
        </select>

        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#c9a84c', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={availableOnly}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAvailableOnly(e.target.checked)}
          />
          Available only
        </label>

        {/* Just the owner filter pointed at yourself — checked whenever it
            already is (e.g. you picked your own name from the dropdown above),
            so the two controls can never disagree. */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#c9a84c', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={user != null && ownerId === String(user.userId)}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOwnerId(e.target.checked && user != null ? String(user.userId) : '')}
          />
          Only my minis
        </label>
      </div>

      {/* Tag filter pills — only shown once tags have loaded */}
      {tags.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '24px' }}>
          {/* "All" pill clears the active tag filter */}
          <button
            onClick={() => setActiveTag('')}
            style={{
              padding: '4px 12px', fontSize: '13px', borderRadius: '20px', border: '1px solid #3d3629',
              background: !activeTag ? '#c9a84c' : '#2e2a22',
              color: !activeTag ? '#1a1500' : '#e8e0d0',
              cursor: 'pointer',
            }}
          >
            All
          </button>

          {/* One pill per tag — clicking the active tag deselects it */}
          {tags.map((tag: string) => (
            <button
              key={tag}
              onClick={() => setActiveTag(activeTag === tag ? '' : tag)}
              style={{
                padding: '4px 12px', fontSize: '13px', borderRadius: '20px', border: '1px solid #3d3629',
                background: activeTag === tag ? '#c9a84c' : '#2e2a22',
                color: activeTag === tag ? '#1a1500' : '#c9a84c',
                cursor: 'pointer',
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {error && <div className="error-msg" style={{ marginBottom: '20px' }}>{error}</div>}

      {/* Content area — loading spinner, empty state, or the mini grid */}
      {loading ? (
        <p style={{ color: '#8a7d6a' }}>Loading…</p>
      ) : minis.length === 0 && !error ? (
        // Only when the collection really is empty — saying "no minis found"
        // because the request failed reads as "your collection is gone".
        <div style={{ textAlign: 'center', padding: '60px 0', color: '#8a7d6a' }}>
          <p style={{ fontSize: '18px', marginBottom: '8px' }}>No minis found</p>
          <p style={{ fontSize: '14px' }}>
            {search || activeTag
              ? 'Try a different search or tag.'
              : <Link to="/upload">Add the first one!</Link>
            }
          </p>
        </div>
      ) : (
        // Responsive grid — fills available width, minimum 220px per card
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: '20px',
        }}>
          {minis.map((mini: Mini) => (
            <MiniCard key={mini.id} mini={mini} onOpenDetail={() => setSelectedMini(mini)} />
          ))}
        </div>
      )}

      {!loading && hasMore && (
        <div style={{ textAlign: 'center', marginTop: '24px' }}>
          <button type="button" className="btn-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}

      {selectedMini && (
        <MiniDetailModal
          mini={selectedMini}
          onClose={() => setSelectedMini(null)}
          isOwn={selectedMini.owner_id === user?.userId}
          inCart={cartMiniIds.has(selectedMini.id)}
          onAddToCart={() => addToCart(selectedMini.id)}
          onTakeOut={(backBy: string | null) => takeOnQuest(selectedMini.id, backBy)}
          onBringBack={() => bringBack(selectedMini.id)}
          showHolds
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MiniCard — displays a single mini in the grid
// ---------------------------------------------------------------------------

function MiniCard({ mini, onOpenDetail }: { mini: Mini; onOpenDetail: () => void }): React.ReactElement {
  const { user } = useAuth();
  const canEdit = user != null && (user.userId === mini.owner_id || user.role === 'admin');

  return (
    <div
      onClick={onOpenDetail}
      style={{
        background: '#252219',
        border: '1px solid #3d3629',
        borderRadius: '8px',
        overflow: 'hidden',
        transition: 'border-color 0.15s, transform 0.15s',
        cursor: 'pointer',
      }}
      // Subtle lift effect on hover — done in JS because inline styles don't support :hover
      onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => {
        e.currentTarget.style.borderColor = '#c9a84c';
        e.currentTarget.style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => {
        e.currentTarget.style.borderColor = '#3d3629';
        e.currentTarget.style.transform = 'none';
      }}
    >
      {/* Photo area — shows the cover photo (first of up to 3) or a placeholder sword icon */}
      <div style={{ height: '180px', background: '#1c1a17', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' }}>
        {mini.images.length > 0 ? (
          <>
            {/* Lazy: a card below the fold doesn't fetch its photo until
                it's scrolled near, and decoding off the main thread keeps
                scrolling smooth. The size is the card's photo box, so
                nothing jumps as photos arrive. */}
            <img
              src={mini.images[0]}
              alt={mini.name}
              loading="lazy"
              decoding="async"
              width={220}
              height={180}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            {mini.images.length > 1 && (
              <span style={{
                position: 'absolute', bottom: '6px', right: '6px', background: 'rgba(0,0,0,0.65)',
                color: '#e8e0d0', fontSize: '11px', padding: '2px 7px', borderRadius: '10px',
              }}>
                +{mini.images.length - 1}
              </span>
            )}
          </>
        ) : (
          <span style={{ fontSize: '48px', opacity: 0.2 }}>⚔</span>
        )}
      </div>

      {/* Card body */}
      <div style={{ padding: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
          <h3 style={{ fontSize: '15px', fontFamily: 'inherit', fontWeight: 600, lineHeight: 1.3 }}>
            {mini.name}
          </h3>
          <MiniStatusBadge status={mini.status} />
        </div>

        <p style={{ fontSize: '12px', color: '#8a7d6a', marginBottom: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>owned by {mini.owner_name}</span>
          {canEdit && (
            <Link
              to={`/minis/${mini.id}/edit`}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              style={{ color: '#c9a84c', fontSize: '12px' }}
            >
              Edit
            </Link>
          )}
        </p>

        {mini.set_name && (
          <p style={{ fontSize: '12px', color: '#8a7d6a', marginBottom: '4px' }}>Part of: {mini.set_name}</p>
        )}

        {mini.price !== null && mini.price > 0 && (
          <p style={{ fontSize: '13px', color: '#c9a84c', fontWeight: 600, marginBottom: '10px' }}>
            ${mini.price.toFixed(2)}
          </p>
        )}

        {/* Description is intentionally not shown here — click the card for the full detail overlay */}

        {/* Tag chips */}
        {mini.tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
            {mini.tags.map((tag: string) => (
              <span key={tag} className="tag">{tag}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
