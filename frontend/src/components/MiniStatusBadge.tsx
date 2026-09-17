import React from 'react';
import { MiniStatus } from '../api/client';

const LABELS: Record<MiniStatus, string> = {
  available: 'Available',
  requested: 'Requested',
  adventuring: 'Adventuring',
};

export default function MiniStatusBadge({ status }: { status: MiniStatus }): React.ReactElement {
  return (
    <span className={`badge-${status}`} style={{ flexShrink: 0 }}>
      {LABELS[status]}
    </span>
  );
}
