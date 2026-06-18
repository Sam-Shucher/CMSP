import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api, Mini } from '../api/client';

// The main browse page — shows a searchable, filterable grid of all minis.
export default function DashboardPage(): React.ReactElement {
  const [minis, setMinis]         = useState<Mini[]>([]);
  const [tags, setTags]           = useState<string[]>([]);  // all tags for the filter bar
  const [search, setSearch]       = useState<string>('');
  const [activeTag, setActiveTag] = useState<string>('');    // currently selected tag filter
  const [loading, setLoading]     = useState<boolean>(true);
  const [error, setError]         = useState<string>('');

  // Fetches minis from the API, passing any active search or tag filter as query params.
  // Wrapped in useCallback so that useEffect only re-runs when search or activeTag actually change.
  const fetchMinis = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (search)    params.set('q', search);
      if (activeTag) params.set('tag', activeTag);
      const data = await api<Mini[]>(`/api/minis?${params.toString()}`);
      setMinis(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load minis');
    } finally {
      setLoading(false);
    }
  }, [search, activeTag]);

  // Re-fetch whenever the search text or active tag changes
  useEffect(() => {
    void fetchMinis();
  }, [fetchMinis]);

  // Load the tag list once on mount — used to render the filter buttons
  useEffect(() => {
    void api<string[]>('/api/minis/tags').then(setTags).catch(() => {});
  }, []);

  return (
    <div style={{ padding: '28px 32px', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '22px', color: '#c9a84c', marginRight: 'auto' }}>The Collection</h2>
        <Link to="/upload">
          <button className="btn-primary">+ Add Mini</button>
        </Link>
      </div>

      {/* Search bar — filters by mini name or description */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input
          style={{ maxWidth: '360px' }}
          type="search"
          placeholder="Search by name or description…"
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
        />
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
      ) : minis.length === 0 ? (
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
            <MiniCard key={mini.id} mini={mini} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MiniCard — displays a single mini in the grid
// ---------------------------------------------------------------------------

function MiniCard({ mini }: { mini: Mini }): React.ReactElement {
  return (
    <div
      style={{
        background: '#252219',
        border: '1px solid #3d3629',
        borderRadius: '8px',
        overflow: 'hidden',
        transition: 'border-color 0.15s, transform 0.15s',
        cursor: 'default',
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
      {/* Photo area — shows the uploaded image or a placeholder sword icon */}
      <div style={{ height: '180px', background: '#1c1a17', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {mini.image_path ? (
          <img
            src={mini.image_path}
            alt={mini.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
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
          {/* Available / Out badge */}
          <span
            className={mini.available ? 'badge-available' : 'badge-unavailable'}
            style={{ flexShrink: 0 }}
          >
            {mini.available ? 'Available' : 'Out'}
          </span>
        </div>

        <p style={{ fontSize: '12px', color: '#8a7d6a', marginBottom: '10px' }}>
          owned by {mini.owner_name}
        </p>

        {/* Description — clamped to 2 lines to keep cards uniform height */}
        {mini.description && (
          <p style={{
            fontSize: '13px', color: '#b0a898', marginBottom: '10px', lineHeight: 1.4,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {mini.description}
          </p>
        )}

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
