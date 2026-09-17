import React, { useEffect, useState } from 'react';
import { Mini } from '../api/client';
import MiniStatusBadge from './MiniStatusBadge';

type MiniDetailModalProps = {
  mini: Mini;
  onClose: () => void;
  // Cart controls only render when onAddToCart is provided.
  isOwn?: boolean;
  inCart?: boolean;
  onAddToCart?: () => Promise<void>;
};

// Full-detail overlay opened by clicking a mini card on the browse page —
// bigger photo with prev/next arrows through all of its images (if it has
// more than one), the full description, and the "add to cart" action.
export default function MiniDetailModal({ mini, onClose, isOwn = false, inCart = false, onAddToCart }: MiniDetailModalProps): React.ReactElement {
  const [index, setIndex] = useState<number>(0);
  const [adding, setAdding] = useState<boolean>(false);
  const [cartError, setCartError] = useState<string>('');
  const imageCount = mini.images.length;

  async function handleAddToCart(): Promise<void> {
    if (!onAddToCart) return;
    setCartError('');
    setAdding(true);
    try {
      await onAddToCart();
    } catch (err: unknown) {
      setCartError(err instanceof Error ? err.message : 'Could not add to cart');
    } finally {
      setAdding(false);
    }
  }

  function next(): void {
    setIndex(i => (i + 1) % imageCount);
  }

  function prev(): void {
    setIndex(i => (i - 1 + imageCount) % imageCount);
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
      if (imageCount > 1) {
        if (e.key === 'ArrowRight') next();
        if (e.key === 'ArrowLeft') prev();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageCount, onClose]);

  return (
    <div
      data-testid="mini-detail-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '24px',
      }}
    >
      <div
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        style={{
          background: '#252219', border: '1px solid #3d3629', borderRadius: '10px',
          width: '100%', maxWidth: '600px', maxHeight: '90vh', overflowY: 'auto',
          position: 'relative',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            ...circleButtonStyle(26),
            position: 'absolute', top: '10px', right: '10px', zIndex: 1,
            fontSize: '16px',
          }}
        >
          ×
        </button>

        {/* Photo — bigger than the card thumbnail, with prev/next when there's more than one */}
        <div style={{
          height: '340px', background: '#1c1a17', display: 'flex',
          alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
          position: 'relative', borderRadius: '10px 10px 0 0',
        }}>
          {imageCount > 0 ? (
            <img
              src={mini.images[index]}
              alt={mini.name}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          ) : (
            <span style={{ fontSize: '64px', opacity: 0.2 }}>⚔</span>
          )}

          {imageCount > 1 && (
            <>
              <button
                type="button"
                onClick={prev}
                aria-label="Previous image"
                style={arrowStyle('left')}
              >
                <ChevronIcon direction="left" />
              </button>
              <button
                type="button"
                onClick={next}
                aria-label="Next image"
                style={arrowStyle('right')}
              >
                <ChevronIcon direction="right" />
              </button>
              <span style={{
                position: 'absolute', bottom: '8px', right: '10px',
                background: 'rgba(0,0,0,0.6)', color: '#e8e0d0', fontSize: '11px',
                padding: '2px 8px', borderRadius: '10px',
              }}>
                {index + 1} / {imageCount}
              </span>
            </>
          )}
        </div>

        {/* Details */}
        <div style={{ padding: '22px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
            <h2 style={{ fontSize: '20px', color: '#c9a84c', fontFamily: 'inherit' }}>{mini.name}</h2>
            <MiniStatusBadge status={mini.status} />
          </div>

          <p style={{ fontSize: '13px', color: '#8a7d6a', marginBottom: '14px' }}>owned by {mini.owner_name}</p>

          {mini.price > 0 && (
            <p style={{ fontSize: '15px', color: '#c9a84c', fontWeight: 600, marginBottom: '14px' }}>
              ${mini.price.toFixed(2)}
            </p>
          )}

          {mini.description && (
            <p style={{ fontSize: '14px', color: '#e8e0d0', lineHeight: 1.6, marginBottom: '16px', whiteSpace: 'pre-wrap' }}>
              {mini.description}
            </p>
          )}

          {mini.tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {mini.tags.map((tag: string) => (
                <span key={tag} className="tag">{tag}</span>
              ))}
            </div>
          )}

          {onAddToCart && (
            <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid #3d3629' }}>
              {isOwn ? (
                <p style={{ fontSize: '13px', color: '#8a7d6a' }}>This is your mini.</p>
              ) : mini.status !== 'available' ? (
                <button type="button" className="btn-secondary" disabled style={{ width: '100%' }}>
                  Not available — {mini.status === 'adventuring' ? 'out adventuring' : 'already requested'}
                </button>
              ) : inCart ? (
                <button type="button" className="btn-secondary" disabled style={{ width: '100%' }}>
                  ✓ In your cart
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void handleAddToCart()}
                  disabled={adding}
                  style={{ width: '100%' }}
                >
                  {adding ? 'Adding…' : 'Add to cart'}
                </button>
              )}
              {cartError && <div className="error-msg" style={{ marginTop: '10px' }}>{cartError}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// The global `button` rule (src/styles/global.css) sets padding: 10px 20px
// on every button. On a fixed-size circular button, 40px of horizontal
// padding is more than the width, so the button grows sideways into an
// oval — padding: 0 keeps the box exactly `size`, and flex centering keeps
// its contents centered.
function circleButtonStyle(size: number): React.CSSProperties {
  return {
    boxSizing: 'border-box',
    padding: 0,
    width: `${size}px`,
    height: `${size}px`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.5)',
    border: 'none',
    borderRadius: '50%',
    color: '#e8e0d0',
    cursor: 'pointer',
    lineHeight: 1,
  };
}

function arrowStyle(side: 'left' | 'right'): React.CSSProperties {
  return {
    ...circleButtonStyle(32),
    position: 'absolute',
    [side]: '10px',
    top: '50%',
    transform: 'translateY(-50%)',
  };
}

// Drawn as SVG rather than a ‹ / › text glyph — those characters aren't
// centered within their own glyph box in most fonts, so no amount of
// flexbox centering on the button fixes it. A vector path has no such
// font-metric ambiguity, so it lands dead-center every time.
function ChevronIcon({ direction }: { direction: 'left' | 'right' }): React.ReactElement {
  const points = direction === 'left' ? '15 6 9 12 15 18' : '9 6 15 12 9 18';
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ display: 'block' }}>
      <polyline
        points={points}
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
