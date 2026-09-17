import { describe, it, expect } from 'vitest';
import { miniStatusFrom, activeLoanStatusSql } from './miniStatus';

describe('miniStatusFrom', () => {
  it('maps an active loan to the status shown on the mini', () => {
    expect(miniStatusFrom('adventuring')).toBe('adventuring');
    expect(miniStatusFrom('negotiating')).toBe('requested');
  });

  it('is available with no active loan', () => {
    expect(miniStatusFrom(null)).toBe('available');
  });

  it('treats finished loans as no longer holding the mini', () => {
    expect(miniStatusFrom('returned')).toBe('available');
    expect(miniStatusFrom('cancelled')).toBe('available');
  });
});

describe('activeLoanStatusSql', () => {
  it('only considers negotiating and adventuring loans for the given mini alias', () => {
    const sql = activeLoanStatusSql('m');
    expect(sql).toContain('l.mini_id = m.id');
    expect(sql).toContain("l.status IN ('negotiating', 'adventuring')");
  });
});
