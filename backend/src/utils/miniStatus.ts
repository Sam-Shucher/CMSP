// A mini has no stored availability flag — it's derived from its loans and
// whether its owner has it out, so it can never drift out of sync.
//   available   → free to add to a cart
//   requested   → checked out by someone, still being negotiated
//   adventuring → handed off to a borrower
//   on_quest    → the owner took it out themselves (e.g. to bring to a game)

export type MiniStatus = 'available' | 'requested' | 'adventuring' | 'on_quest';

// A correlated subquery for the mini's active loan status (or NULL). Pass the
// SQL alias used for the minis table in the surrounding query.
export function activeLoanStatusSql(miniAlias: string): string {
  return `(SELECT l.status FROM loans l
           WHERE l.mini_id = ${miniAlias}.id AND l.status IN ('negotiating', 'adventuring')
           LIMIT 1)`;
}

export function miniStatusFrom(activeLoanStatus: string | null, onQuestSince: Date | string | null = null): MiniStatus {
  if (activeLoanStatus === 'adventuring') return 'adventuring';
  if (activeLoanStatus === 'negotiating') return 'requested';
  if (onQuestSince) return 'on_quest';
  return 'available';
}
