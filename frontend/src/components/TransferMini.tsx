import React, { useState } from 'react';
import { api, Mini, MiniOwner } from '../api/client';
import ConfirmDeleteModal from './ConfirmDeleteModal';

type TransferMiniProps = {
  miniId: number;
  miniName: string;
  ownerId: number; // the mini's CURRENT owner — excluded from the recipient list
  onTransferred: (mini: Mini) => void;
};

// "Someone sells or gives it to another member" — hands the mini to another
// collection member in one step, keeping its tags, photos, price, and lending
// history (unlike delete-and-recreate). Collapsed by default and the member
// list is fetched only on request, same reasoning as MiniHistory.
export default function TransferMini({ miniId, miniName, ownerId, onTransferred }: TransferMiniProps): React.ReactElement {
  const [open, setOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  // null = never fetched yet; distinguishes "not loaded" from "loaded, empty".
  const [members, setMembers] = useState<MiniOwner[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [confirming, setConfirming] = useState<boolean>(false);

  async function reveal(): Promise<void> {
    setOpen(true);
    if (members !== null) return; // already have it — closing and reopening shouldn't re-fetch
    setLoading(true);
    setError('');
    try {
      const all = await api<MiniOwner[]>('/api/minis/collection-members');
      setMembers(all.filter(member => member.id !== ownerId));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load collection members');
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm(): Promise<void> {
    setError('');
    try {
      const updated = await api<Mini>(`/api/minis/${miniId}/transfer`, { method: 'POST', json: { newOwnerId: Number(selectedId) } });
      setConfirming(false);
      onTransferred(updated);
    } catch (err: unknown) {
      setConfirming(false);
      setError(err instanceof Error ? err.message : 'Failed to transfer ownership');
    }
  }

  const selectedMember = members?.find(member => String(member.id) === selectedId) ?? null;

  return (
    <div style={{ marginTop: '24px', paddingTop: '20px', borderTop: '1px solid #3d3629' }}>
      <button
        type="button"
        className="btn-secondary"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : void reveal())}
      >
        {open ? 'Hide transfer ownership' : 'Transfer Ownership'}
      </button>

      {open && (
        <div style={{ marginTop: '12px' }}>
          {loading && <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</p>}
          {error && <div className="error-msg" style={{ fontSize: '13px', marginBottom: '10px' }}>{error}</div>}

          {members?.length === 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>There's nobody else in this collection to give it to yet.</p>
          )}

          {members && members.length > 0 && (
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                aria-label="Give to"
                value={selectedId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSelectedId(e.target.value)}
              >
                <option value="">Choose a member…</option>
                {members.map((member: MiniOwner) => (
                  <option key={member.id} value={member.id}>{member.name}</option>
                ))}
              </select>
              <button
                type="button"
                className="btn-primary"
                disabled={!selectedId}
                onClick={() => setConfirming(true)}
              >
                Transfer
              </button>
            </div>
          )}
        </div>
      )}

      {confirming && selectedMember && (
        <ConfirmDeleteModal
          title="Transfer ownership"
          description={`This gives ${miniName} to ${selectedMember.name}. They'll be able to edit or delete it, and it will leave any set it's part of. This can be undone later by transferring it back.`}
          confirmPhrase={selectedMember.name}
          confirmButtonLabel="Confirm Transfer"
          onConfirm={() => void handleConfirm()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
