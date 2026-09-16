import React, { useState } from 'react';

type ConfirmDeleteModalProps = {
  title: string;
  description: string;
  confirmPhrase: string;       // exact text the user must retype to unlock the delete button
  confirmButtonLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

// AWS/Postman-style "type to confirm" guard for destructive admin actions.
// The delete button stays disabled until the typed text exactly matches
// confirmPhrase, so a mis-click can't delete the wrong thing.
export default function ConfirmDeleteModal({
  title,
  description,
  confirmPhrase,
  confirmButtonLabel,
  onConfirm,
  onCancel,
}: ConfirmDeleteModalProps): React.ReactElement {
  const [typed, setTyped] = useState<string>('');
  const matches = typed === confirmPhrase;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div style={{
        background: '#252219', border: '1px solid #3d3629', borderRadius: '10px',
        padding: '28px', width: '100%', maxWidth: '420px',
      }}>
        <h3 style={{ fontSize: '17px', color: '#c9a84c', marginBottom: '10px' }}>{title}</h3>
        <p style={{ fontSize: '13px', color: '#8a7d6a', marginBottom: '16px' }}>{description}</p>

        <label style={{ display: 'block', fontSize: '12px', color: '#8a7d6a', marginBottom: '6px' }} htmlFor="confirm-delete-input">
          Type <strong style={{ color: '#e8e0d0' }}>{confirmPhrase}</strong> to confirm
        </label>
        <input
          id="confirm-delete-input"
          type="text"
          value={typed}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTyped(e.target.value)}
          autoFocus
          style={{ marginBottom: '18px' }}
        />

        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            type="button"
            className="btn-danger"
            disabled={!matches}
            onClick={onConfirm}
            style={{ flex: 1, padding: '10px' }}
          >
            {confirmButtonLabel}
          </button>
          <button type="button" className="btn-secondary" onClick={onCancel} style={{ padding: '10px 20px' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
