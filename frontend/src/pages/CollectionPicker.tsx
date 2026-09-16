import React from 'react';
import { Collection } from '../api/client';

type CollectionPickerProps = {
  collections: Collection[];
  onSelect: (id: number) => void;
};

// Shown after login/registration when the user belongs to more than one
// collection (group), and via the nav's "Switch" control. Picking one calls
// through to POST /api/auth/select-collection, which re-verifies membership
// server-side before granting access — this page is just the UI for that.
export default function CollectionPicker({ collections, onSelect }: CollectionPickerProps): React.ReactElement {
  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={{ fontSize: '20px', color: '#c9a84c', marginBottom: '8px' }}>Select a Group</h1>
        <p style={{ color: '#8a7d6a', marginBottom: '24px', fontSize: '13px' }}>
          Choose which group you want to browse and manage.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {collections.map((c: Collection) => (
            <button
              key={c.id}
              type="button"
              className="btn-primary"
              onClick={() => onSelect(c.id)}
              style={{ padding: '14px' }}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px',
};

const cardStyle: React.CSSProperties = {
  background: '#252219',
  border: '1px solid #3d3629',
  borderRadius: '10px',
  boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
  padding: '36px 40px',
  width: '100%',
  maxWidth: '360px',
};
