import React from 'react';
import { MiniStatus } from '../api/client';

const LABELS: Record<MiniStatus, string> = {
  available: 'Available',
  requested: 'Requested',
  adventuring: 'Adventuring',
  on_quest: 'On a Quest',
  lost: 'Lost',
  critically_wounded: 'Critically Wounded',
};

export default function MiniStatusBadge({ status }: { status: MiniStatus }): React.ReactElement {
  return (
    <span className={`badge-${status}`} style={{ flexShrink: 0 }}>
      {LABELS[status]}
    </span>
  );
}
