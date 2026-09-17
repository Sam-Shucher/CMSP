import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, NotificationItem } from '../api/client';
import { timeAgo } from '../utils/timeAgo';

export const POLL_INTERVAL_MS = 60 * 1000;

type Inbox = { unread: number; items: NotificationItem[] };

// The bell in the nav: unread count, and a dropdown of recent notifications
// for the group you're in. Checks for new ones every minute.
export default function NotificationBell({ collectionId }: { collectionId?: number }): React.ReactElement {
  const navigate = useNavigate();
  const [inbox, setInbox] = useState<Inbox>({ unread: 0, items: [] });
  const [open, setOpen] = useState<boolean>(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await api<Partial<Inbox>>('/api/notifications');
      setInbox({ unread: Number(data.unread) || 0, items: Array.isArray(data.items) ? data.items : [] });
    } catch {
      // Keep showing what we had; the next check will try again.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, collectionId]);

  // Everything about loans and holds lives on the Loans page.
  async function openNotification(item: NotificationItem): Promise<void> {
    setOpen(false);
    if (!item.read) {
      try {
        await api(`/api/notifications/${item.id}/read`, { method: 'POST' });
      } catch {
        // Still take them where they were going.
      }
    }
    navigate('/loans');
    void load();
  }

  async function markAllRead(): Promise<void> {
    try {
      await api('/api/notifications/read-all', { method: 'POST' });
    } finally {
      void load();
    }
  }

  const label = inbox.unread > 0 ? `Notifications (${inbox.unread} unread)` : 'Notifications';

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        style={{ background: 'none', border: 'none', color: '#e8e0d0', cursor: 'pointer', padding: '4px', position: 'relative', fontSize: '18px', lineHeight: 1 }}
      >
        <span aria-hidden="true">🔔</span>
        {inbox.unread > 0 && (
          <span aria-hidden="true" style={{
            position: 'absolute', top: '-4px', right: '-6px', background: '#c0392b', color: '#fff',
            borderRadius: '10px', fontSize: '10px', fontWeight: 700, padding: '1px 5px', minWidth: '16px', textAlign: 'center',
          }}>
            {inbox.unread > 99 ? '99+' : inbox.unread}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', right: 0, top: '36px', width: 'min(340px, 90vw)', maxHeight: '420px', overflowY: 'auto',
          background: '#252219', border: '1px solid #3d3629', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,0.5)', zIndex: 900,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid #3d3629' }}>
            <strong style={{ fontSize: '14px', color: '#c9a84c' }}>Notifications</strong>
            {inbox.unread > 0 && (
              <button type="button" onClick={() => void markAllRead()} style={{ background: 'none', border: 'none', color: '#8a7d6a', fontSize: '12px', cursor: 'pointer', padding: 0 }}>
                Mark all read
              </button>
            )}
          </div>
          {inbox.items.length === 0 ? (
            <p style={{ padding: '16px 12px', fontSize: '13px', color: '#8a7d6a' }}>No notifications yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {inbox.items.map(item => (
                <li key={item.id} style={{ borderBottom: '1px solid #3d3629' }}>
                  <button
                    type="button"
                    onClick={() => void openNotification(item)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', border: 'none', cursor: 'pointer',
                      background: item.read ? 'transparent' : 'rgba(201, 168, 76, 0.08)', color: '#e8e0d0', borderRadius: 0,
                    }}
                  >
                    <span style={{ display: 'block', fontSize: '13px', fontWeight: item.read ? 400 : 600 }}>{item.message}</span>
                    <span style={{ display: 'block', fontSize: '11px', color: '#8a7d6a', marginTop: '2px' }}>{timeAgo(item.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
