import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, CartItem, CART_CHANGED_EVENT } from '../api/client';
import MiniStatusBadge from '../components/MiniStatusBadge';

type CheckoutResult = {
  created: { loanId: number; miniId: number }[];
  unavailable: { miniId: number; name: string }[];
};

// The basket. Nothing here is reserved — checking out is what sends each
// owner a formal request, and that request is the borrower's place in line.
export default function CartPage(): React.ReactElement {
  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [checkingOut, setCheckingOut] = useState<boolean>(false);
  const [result, setResult] = useState<CheckoutResult | null>(null);

  const loadCart = useCallback(async (): Promise<void> => {
    try {
      setItems(await api<CartItem[]>('/api/cart'));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load your cart');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCart();
  }, [loadCart]);

  async function remove(miniId: number): Promise<void> {
    setError('');
    try {
      await api(`/api/cart/${miniId}`, { method: 'DELETE' });
      await loadCart();
      window.dispatchEvent(new Event(CART_CHANGED_EVENT)); // the count in the nav
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not remove that mini');
    }
  }

  async function checkout(): Promise<void> {
    setError('');
    setResult(null);
    setCheckingOut(true);
    try {
      setResult(await api<CheckoutResult>('/api/cart/checkout', { method: 'POST' }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setCheckingOut(false);
      await loadCart();
      // Checkout empties the cart (or all but what wasn't available).
      window.dispatchEvent(new Event(CART_CHANGED_EVENT));
    }
  }

  // Group by owner — each owner gets their own requests to negotiate.
  const groups = new Map<number, { ownerName: string; items: CartItem[] }>();
  for (const cartItem of items) {
    const group = groups.get(cartItem.ownerId) ?? { ownerName: cartItem.ownerName, items: [] };
    group.items.push(cartItem);
    groups.set(cartItem.ownerId, group);
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: '800px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '22px', color: '#c9a84c', marginBottom: '8px' }}>Your Cart</h2>
      <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '24px' }}>
        Adding a mini to your cart doesn't reserve it. Checking out sends a request to each owner —
        then you'll work out when, where, and how together on the Loans page.
      </p>

      {error && <div className="error-msg" style={{ marginBottom: '16px' }}>{error}</div>}

      {result && result.created.length > 0 && (
        <div className="success-msg" style={{ marginBottom: '16px' }}>
          <p>
            Sent {result.created.length} {result.created.length === 1 ? 'request' : 'requests'}.{' '}
            <Link to="/loans">Go to your loans</Link> to negotiate the details.
          </p>
          {result.unavailable.map((u: { miniId: number; name: string }) => (
            <p key={u.miniId} style={{ marginTop: '4px' }}>
              {u.name} wasn't available, so it's still in your cart.
            </p>
          ))}
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
          <p style={{ fontSize: '18px', marginBottom: '8px' }}>Your cart is empty</p>
          <Link to="/">Browse the collection</Link>
        </div>
      ) : (
        <>
          {[...groups.entries()].map(([ownerId, group]) => (
            <section
              key={ownerId}
              aria-label={`From ${group.ownerName}`}
              style={{ background: '#252219', border: '1px solid #3d3629', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}
            >
              <h3 style={{ fontSize: '15px', color: '#e8e0d0', marginBottom: '12px' }}>From {group.ownerName}</h3>
              {group.items.map((cartItem: CartItem) => (
                <div
                  key={cartItem.miniId}
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0', borderTop: '1px solid #3d3629' }}
                >
                  <div style={{ width: '48px', height: '48px', flexShrink: 0, background: '#1c1a17', borderRadius: '4px', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {cartItem.image
                      ? <img src={cartItem.image} alt="" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <span style={{ opacity: 0.2 }}>⚔</span>}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{cartItem.name}</div>
                    {cartItem.status !== 'available' && (
                      <div style={{ fontSize: '12px', color: 'var(--danger-text)' }}>No longer available</div>
                    )}
                  </div>
                  <MiniStatusBadge status={cartItem.status} />
                  <button
                    type="button"
                    className="btn-secondary"
                    aria-label={`Remove ${cartItem.name}`}
                    onClick={() => void remove(cartItem.miniId)}
                    style={{ padding: '6px 12px', fontSize: '13px' }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </section>
          ))}

          <button
            type="button"
            className="btn-primary"
            onClick={() => void checkout()}
            disabled={checkingOut}
            style={{ width: '100%' }}
          >
            {checkingOut ? 'Checking out…' : 'Checkout'}
          </button>
        </>
      )}
    </div>
  );
}
