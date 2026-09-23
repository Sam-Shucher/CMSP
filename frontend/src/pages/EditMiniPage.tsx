import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, Mini } from '../api/client';
import MiniForm, { MiniFormValues } from '../components/MiniForm';
import ConfirmDeleteModal from '../components/ConfirmDeleteModal';
import MiniHistory from '../components/MiniHistory';
import TransferMini from '../components/TransferMini';

// Page for editing a mini you already own (or, if you're an admin, anyone's).
// The server re-checks ownership on submit regardless of what's shown here.
export default function EditMiniPage(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [mini, setMini]           = useState<Mini | null>(null);
  const [loadError, setLoadError] = useState<string>('');
  const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string>('');
  const [clearingCondition, setClearingCondition] = useState<boolean>(false);
  const [clearError, setClearError] = useState<string>('');

  useEffect(() => {
    api<Mini>(`/api/minis/${id}`)
      .then(setMini)
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load mini'));
  }, [id]);

  async function handleSubmit(values: MiniFormValues, newImages: File[], keptExistingImages: string[]): Promise<void> {
    const fd = new FormData();
    fd.append('name', values.name);
    if (values.description.trim()) fd.append('description', values.description.trim());
    if (values.tags.trim())        fd.append('tags', values.tags.trim());
    if (values.price.trim())       fd.append('price', values.price.trim());
    fd.append('existingImages', JSON.stringify(keptExistingImages));
    newImages.forEach((file: File) => fd.append('images', file));

    await api(`/api/minis/${id}`, { method: 'PATCH', body: fd });
    navigate('/'); // back to the dashboard after a successful edit
  }

  // Puts a lost/critically wounded mini back into service — see
  // routes/minis.ts's POST /:id/clear-condition. "Lost" has nothing to
  // restore automatically, but nothing stops clearing one found later; same
  // action either way.
  async function handleClearCondition(): Promise<void> {
    setClearError('');
    setClearingCondition(true);
    try {
      setMini(await api<Mini>(`/api/minis/${id}/clear-condition`, { method: 'POST' }));
    } catch (err: unknown) {
      setClearError(err instanceof Error ? err.message : 'Failed to clear condition');
    } finally {
      setClearingCondition(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setDeleteError('');
    try {
      await api(`/api/minis/${id}`, { method: 'DELETE' });
      navigate('/'); // back to the dashboard after a successful delete
    } catch (err: unknown) {
      // e.g. 409 while the mini is requested or out adventuring
      setConfirmingDelete(false);
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete mini');
    }
  }

  if (loadError) {
    return (
      <div style={{ padding: '28px 32px', maxWidth: '640px', margin: '0 auto' }}>
        <div className="error-msg">{loadError}</div>
      </div>
    );
  }

  if (!mini) {
    return <div style={{ padding: '28px 32px', color: '#8a7d6a' }}>Loading…</div>;
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: '640px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '22px', color: '#c9a84c', marginBottom: '24px' }}>Edit Mini</h2>

      {/* Hidden from browse while this is set (routes/minis.ts) — shown here
          since the owner/admin still needs full access to see and clear it. */}
      {mini.condition && (
        <div style={{
          background: 'rgba(192, 57, 43, 0.1)', border: '1px solid #c0392b', borderRadius: '8px',
          padding: '14px 16px', marginBottom: '20px',
        }}>
          <p style={{ fontSize: '13px', color: '#e8e0d0', marginBottom: clearError ? '8px' : '10px' }}>
            This mini is marked <strong>{mini.condition === 'lost' ? 'Lost' : 'Critically Wounded'}</strong>
            {mini.conditionSince ? ` since ${new Date(mini.conditionSince).toLocaleDateString()}` : ''} — hidden from the collection until cleared.
          </p>
          {clearError && <div className="error-msg" style={{ fontSize: '13px', marginBottom: '10px' }}>{clearError}</div>}
          <button type="button" className="btn-secondary" disabled={clearingCondition} onClick={() => void handleClearCondition()}>
            {clearingCondition ? 'Clearing…' : 'Clear condition'}
          </button>
        </div>
      )}

      <MiniForm
        initialValues={{
          name: mini.name,
          description: mini.description ?? '',
          tags: mini.tags.join(','),
          price: Number(mini.price).toFixed(2),
        }}
        initialImages={mini.images}
        submitLabel="Save Changes"
        submittingLabel="Saving…"
        onSubmit={handleSubmit}
        onCancel={() => navigate('/')}
      />

      {/* "Who's had this, how often" — collapsed by default, so a routine
          edit doesn't pay for a fetch nobody asked for. */}
      <MiniHistory miniId={mini.id} />

      {/* Also collapsed by default — the member list is fetched only if asked. */}
      <TransferMini
        miniId={mini.id}
        miniName={mini.name}
        ownerId={mini.owner_id}
        onTransferred={() => navigate('/')}
      />

      {/* Kept separate from the form's own buttons so a mistaken click while
          editing doesn't land anywhere near "delete this permanently". */}
      <div style={{ marginTop: '24px', paddingTop: '20px', borderTop: '1px solid #3d3629' }}>
        {deleteError && <div className="error-msg" style={{ marginBottom: '12px' }}>{deleteError}</div>}
        <button type="button" className="btn-danger" onClick={() => setConfirmingDelete(true)}>
          Delete Mini
        </button>
      </div>

      {confirmingDelete && (
        <ConfirmDeleteModal
          title="Delete mini"
          description="This permanently deletes this mini and its photos. This cannot be undone."
          confirmPhrase={mini.name}
          confirmButtonLabel="Confirm Delete"
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
