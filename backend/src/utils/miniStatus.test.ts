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

  it('is "on a quest" while the owner has taken it out themselves', () => {
    expect(miniStatusFrom(null, new Date('2026-10-01T18:00:00Z'))).toBe('on_quest');
    expect(miniStatusFrom('returned', new Date('2026-10-01T18:00:00Z'))).toBe('on_quest');
  });

  it('is available again once the owner brings it back', () => {
    expect(miniStatusFrom(null, null)).toBe('available');
  });

  it('a condition wins over an active loan or quest, since ending one is what sets it', () => {
    expect(miniStatusFrom('adventuring', null, 'lost')).toBe('lost');
    expect(miniStatusFrom(null, new Date('2026-10-01T18:00:00Z'), 'critically_wounded')).toBe('critically_wounded');
  });

  it('ignores a condition of null', () => {
    expect(miniStatusFrom('adventuring', null, null)).toBe('adventuring');
  });
});

describe('activeLoanStatusSql', () => {
  it('only considers negotiating and adventuring loans for the given mini alias', () => {
    const sql = activeLoanStatusSql('m');
    expect(sql).toContain('l.mini_id = m.id');
    expect(sql).toContain("l.status IN ('negotiating', 'adventuring')");
  });
});
