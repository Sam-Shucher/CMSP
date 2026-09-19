import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, CartItem, CART_CHANGED_EVENT } from '../api/client';
import { POLL_MS } from '../limits';

export const POLL_INTERVAL_MS = POLL_MS.cart;

// Two digits is all the nav has room for.
const MOST_SHOWN = 99;

// The Cart link in the nav, with a count of what's waiting in it. The count is
// the cart itself rather than a tally we keep, so it stays right when a mini is
// added in another tab or the cart is checked out from one.
export default function CartLink({ collectionId }: { collectionId?: number }): React.ReactElement {
  const [count, setCount] = useState<number>(0);

  const load = useCallback(async (): Promise<void> => {
    try {
      const items = await api<CartItem[]>('/api/cart');
      setCount(Array.isArray(items) ? items.length : 0);
    } catch {
      // Leave the count as it was — the link still works, and the next look
      // (a minute away, or the next cart change) will put it right.
    }
  }, []);

  // Fresh on arrival, the moment a page says the cart changed, and once a
  // minute in case it changed somewhere this tab can't see.
  useEffect(() => {
    const reload = (): void => void load();
    reload();
    window.addEventListener(CART_CHANGED_EVENT, reload);
    const timer = setInterval(reload, POLL_INTERVAL_MS);
    return () => {
      window.removeEventListener(CART_CHANGED_EVENT, reload);
      clearInterval(timer);
    };
  }, [load, collectionId]);

  return (
    <span className="cart-link">
      <Link to="/cart" style={{ color: '#e8e0d0', fontSize: '14px' }}>Cart</Link>
      {count > 0 && (
        // Keyed by the count so React remounts it and the pop plays again
        // each time the number changes.
        <span key={count} className="cart-badge" data-testid="cart-count" aria-hidden="true">
          {count > MOST_SHOWN ? `${MOST_SHOWN}+` : count}
        </span>
      )}
      {/* The badge is decorative — it would otherwise rename the link, which
          the end-to-end tests and anyone using a screen reader both rely on.
          The count is announced here instead, as it changes. */}
      {/* aria-live rather than role="status": the group notice in App owns that
          role, and a page should only have the one status region. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true" data-testid="cart-count-status">
        {count > 0 ? `${count} ${count === 1 ? 'mini' : 'minis'} in your cart` : ''}
      </span>
    </span>
  );
}
