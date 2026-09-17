// A mini has no stored availability flag — it's derived from its loans, so it
// can never drift out of sync with them.
//   available   → no active loan
//   requested   → checked out, still being negotiated
//   adventuring → handed off to the borrower

export type MiniStatus = 'available' | 'requested' | 'adventuring';

// A correlated subquery for the mini's active loan status (or NULL). Pass the
// SQL alias used for the minis table in the surrounding query.
export function activeLoanStatusSql(miniAlias: string): string {
  return `(SELECT l.status FROM loans l
           WHERE l.mini_id = ${miniAlias}.id AND l.status IN ('negotiating', 'adventuring')
           LIMIT 1)`;
}

export function miniStatusFrom(activeLoanStatus: string | null): MiniStatus {
  if (activeLoanStatus === 'adventuring') return 'adventuring';
  if (activeLoanStatus === 'negotiating') return 'requested';
  return 'available';
}
