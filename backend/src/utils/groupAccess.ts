// What being in a group lets someone do there: their role in it, and the
// group's own settings that change what the routes send back. Read from
// collection_memberships joined to collections — by db/sessions.ts in the same
// query that checks the session, or by requireCollectionMembership when that
// didn't happen — and turned into this shape here, so the two can't disagree.

export interface GroupAccess {
  // Their role IN THIS GROUP. Anything unexpected in the column counts as a
  // plain member — being an admin is never the fallback.
  role: 'admin' | 'user';
  // Whether this group shows prices at all (collections.show_prices).
  showPrices: boolean;
}

export interface GroupAccessRow {
  role: string | null;
  show_prices: number | null;
}

export function groupAccessFrom(row: GroupAccessRow): GroupAccess {
  return {
    role: row.role === 'admin' ? 'admin' : 'user',
    // Shown unless the group has turned them off — the column's default.
    showPrices: row.show_prices !== 0,
  };
}
