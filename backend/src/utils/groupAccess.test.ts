import { describe, it, expect } from 'vitest';
import { groupAccessFrom } from './groupAccess';

describe('groupAccessFrom', () => {
  it('reads an admin as an admin', () => {
    expect(groupAccessFrom({ role: 'admin', show_prices: 1 })).toEqual({ role: 'admin', showPrices: true });
  });

  it('treats any other role value, including none, as a plain member', () => {
    expect(groupAccessFrom({ role: 'user', show_prices: 1 }).role).toBe('user');
    expect(groupAccessFrom({ role: null, show_prices: 1 }).role).toBe('user');
    expect(groupAccessFrom({ role: 'superuser', show_prices: 1 }).role).toBe('user');
  });

  it('shows prices unless the group has turned them off', () => {
    expect(groupAccessFrom({ role: 'user', show_prices: 0 }).showPrices).toBe(false);
    expect(groupAccessFrom({ role: 'user', show_prices: 1 }).showPrices).toBe(true);
    expect(groupAccessFrom({ role: 'user', show_prices: null }).showPrices).toBe(true);
  });
});
