import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Mini, MiniSet, SetCartResult, CART_CHANGED_EVENT } from '../api/client';
import { useAuth } from '../App';
import MiniStatusBadge from '../components/MiniStatusBadge';
import { LIMITS, PAGE_SIZE } from '../limits';

const cardStyle: React.CSSProperties = {
  background: '#252219', border: '1px solid #3d3629', borderRadius: '8px',
  padding: '16px', marginBottom: '16px',
};

function reasonText(reason: SetCartResult['skipped'][number]['reason']): string {
  if (reason === 'own') return "that's your own mini";
  if (reason === 'already_in_cart') return 'already in your cart';
  return 'not available right now';
}

// All of your own minis — the ones a set can be made from. The browse list
// comes a page at a time, so this keeps asking, carrying on after the last one,
// until a page comes back short. Only yours are asked for, so it's usually one.
async function fetchOwnMinis(userId: number): Promise<Mini[]> {
  const mine: Mini[] = [];
  for (;;) {
    const params = new URLSearchParams({ owner: String(userId) });
    if (mine.length > 0) params.set('after', String(mine[mine.length - 1].id));
    const page = await api<Mini[]>(`/api/minis?${params.toString()}`);
    mine.push(...page);
    if (page.length < PAGE_SIZE.browsePage) return mine;
  }
}

// A named group of one owner's own minis — a boxed army, a Kill Team —
// borrowed together with one action instead of one at a time.
export default function SetsPage(): React.ReactElement {
  const { user } = useAuth();
  const [sets, setSets] = useState<MiniSet[]>([]);
  const [myMinis, setMyMinis] = useState<Mini[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const [setsRes, minisRes] = await Promise.all([
        api<MiniSet[]>('/api/sets'),
        fetchOwnMinis(user!.userId),
      ]);
      setSets(setsRes);
      setMyMinis(minisRes);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load sets');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  // Candidates for a new set, or for adding to one you own: your own minis
  // not already grouped into some other set.
  const ungrouped = myMinis.filter((m: Mini) => m.set_id === null);

  const [newName, setNewName] = useState<string>('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState<boolean>(false);
  const [createError, setCreateError] = useState<string>('');

  function toggleSelected(id: number): void {
    setSelected((prev: Set<number>) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function createSet(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreateError('');
    setCreating(true);
    try {
      await api('/api/sets', { method: 'POST', json: { name: newName.trim(), miniIds: [...selected] } });
      setNewName('');
      setSelected(new Set());
      await load();
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create set');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: '800px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '22px', color: '#c9a84c', marginBottom: '8px' }}>Sets</h2>
      <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '24px' }}>
        Group your own minis into a set — a boxed army, a Kill Team — so someone can borrow the whole thing in one go.
      </p>

      {error && <div className="error-msg" style={{ marginBottom: '16px' }}>{error}</div>}

      <form noValidate onSubmit={(e: React.FormEvent) => void createSet(e)} style={cardStyle}>
        <h3 style={{ fontSize: '15px', color: '#e8e0d0', marginBottom: '12px' }}>Create a set</h3>
        <label htmlFor="new-set-name" style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Name</label>
        <input
          id="new-set-name"
          value={newName}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
          maxLength={LIMITS.setName}
          style={{ marginBottom: '12px' }}
        />

        {ungrouped.length > 0 && (
          <fieldset style={{ border: 'none', padding: 0, marginBottom: '12px' }}>
            <legend style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px', padding: 0 }}>
              Add your minis (optional — you can add more later)
            </legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {ungrouped.map((m: Mini) => (
                <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px' }}>
                  <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggleSelected(m.id)} />
                  {m.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {createError && <div className="error-msg" style={{ marginBottom: '12px' }}>{createError}</div>}
        <button type="submit" className="btn-primary" disabled={creating || !newName.trim()}>
          {creating ? 'Creating…' : 'Create Set'}
        </button>
      </form>

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : sets.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No sets yet.</p>
      ) : (
        sets.map((s: MiniSet) => (
          <SetCard
            key={s.id}
            set={s}
            isMine={s.ownerId === user!.userId}
            isAdmin={user!.role === 'admin'}
            ungrouped={ungrouped}
            onChanged={load}
          />
        ))
      )}
    </div>
  );
}

function SetCard({ set, isMine, isAdmin, ungrouped, onChanged }: {
  set: MiniSet;
  isMine: boolean;
  isAdmin: boolean;
  ungrouped: Mini[]; // the CALLER's own ungrouped minis — only meaningful when isMine
  onChanged: () => Promise<void>;
}): React.ReactElement {
  const canManage = isMine || isAdmin;
  const [name, setName] = useState<string>(set.name);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);
  const [addMiniId, setAddMiniId] = useState<string>('');
  const [borrowing, setBorrowing] = useState<boolean>(false);
  const [borrowResult, setBorrowResult] = useState<SetCartResult | null>(null);

  // Pick up a rename made elsewhere (another tab, an admin) without wiping an
  // edit in progress here.
  const [lastSavedName, setLastSavedName] = useState<string>(set.name);
  if (lastSavedName !== set.name) {
    setLastSavedName(set.name);
    setName(set.name);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setError('');
    setBusy(true);
    try {
      await action();
      await onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  function rename(): Promise<void> {
    return run(async () => {
      await api(`/api/sets/${set.id}`, { method: 'PATCH', json: { name: name.trim() } });
    });
  }

  function addMember(): Promise<void> {
    return run(async () => {
      await api(`/api/sets/${set.id}`, { method: 'PATCH', json: { addMiniIds: [Number(addMiniId)] } });
      setAddMiniId('');
    });
  }

  function removeMember(miniId: number): Promise<void> {
    return run(async () => {
      await api(`/api/sets/${set.id}`, { method: 'PATCH', json: { removeMiniIds: [miniId] } });
    });
  }

  function deleteSet(): Promise<void> {
    return run(async () => {
      await api(`/api/sets/${set.id}`, { method: 'DELETE' });
      setConfirmingDelete(false);
    });
  }

  async function borrow(): Promise<void> {
    setError('');
    setBorrowing(true);
    setBorrowResult(null);
    try {
      const result = await api<SetCartResult>(`/api/sets/${set.id}/cart`, { method: 'POST' });
      setBorrowResult(result);
      window.dispatchEvent(new Event(CART_CHANGED_EVENT)); // the count in the nav
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not borrow this set');
    } finally {
      setBorrowing(false);
    }
  }

  return (
    <section aria-label={set.name} style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' }}>
        <h3 style={{ fontSize: '16px', color: '#e8e0d0' }}>{set.name}</h3>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>by {set.ownerName}</span>
      </div>

      {set.members.length === 0 ? (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Nothing in this set yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
          {set.members.map((m: Mini) => (
            <li key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0', borderTop: '1px solid #3d3629' }}>
              <span style={{ flex: 1 }}>{m.name}</span>
              <MiniStatusBadge status={m.status} />
              {canManage && (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  aria-label={`Remove ${m.name} from ${set.name}`}
                  onClick={() => void removeMember(m.id)}
                  style={{ padding: '4px 10px', fontSize: '12px' }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!isMine && (
        <div style={{ marginBottom: canManage ? '12px' : 0 }}>
          <button type="button" className="btn-primary" disabled={borrowing} onClick={() => void borrow()}>
            {borrowing ? 'Borrowing…' : 'Borrow this set'}
          </button>
          {borrowResult && (
            <div className="success-msg" style={{ marginTop: '10px' }}>
              {borrowResult.added.length > 0 && (
                <p>
                  Added {borrowResult.added.length} mini{borrowResult.added.length === 1 ? '' : 's'} to your cart.{' '}
                  <Link to="/cart">Go to your cart</Link>
                </p>
              )}
              {borrowResult.skipped.map((s: SetCartResult['skipped'][number]) => (
                <p key={s.miniId} style={{ marginTop: '4px' }}>{s.name}: {reasonText(s.reason)}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {canManage && (
        <div style={{ borderTop: '1px solid #3d3629', paddingTop: '12px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end' }}>
          <div>
            <label htmlFor={`rename-${set.id}`} style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>
              Rename
            </label>
            <input
              id={`rename-${set.id}`}
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              maxLength={LIMITS.setName}
            />
          </div>
          <button
            type="button" className="btn-secondary" disabled={busy || !name.trim() || name.trim() === set.name}
            onClick={() => void rename()}
          >
            Save name
          </button>

          {/* Adding a member needs to know the OWNER's other ungrouped minis —
              only available here when the caller is that owner. An admin can
              still rename, delete, or remove existing members of anyone's set. */}
          {isMine && ungrouped.length > 0 && (
            <>
              <div>
                <label htmlFor={`add-${set.id}`} style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  Add a mini
                </label>
                <select
                  id={`add-${set.id}`}
                  value={addMiniId}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setAddMiniId(e.target.value)}
                >
                  <option value="">Choose one…</option>
                  {ungrouped.map((m: Mini) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <button type="button" className="btn-secondary" disabled={busy || !addMiniId} onClick={() => void addMember()}>
                Add
              </button>
            </>
          )}

          {confirmingDelete ? (
            <>
              <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Delete this set? Its minis stay, just ungrouped.</span>
              <button type="button" className="btn-danger" disabled={busy} onClick={() => void deleteSet()}>Yes, delete</button>
              <button type="button" className="btn-secondary" onClick={() => setConfirmingDelete(false)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="btn-danger" onClick={() => setConfirmingDelete(true)}>Delete Set</button>
          )}
        </div>
      )}

      {error && <div className="error-msg" style={{ marginTop: '10px' }}>{error}</div>}
    </section>
  );
}
