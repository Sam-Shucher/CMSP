import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import { api, User, Collection, SESSION_ENDED_EVENT, GROUP_CHANGED_EVENT, setActiveGroup } from './api/client';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';
import UploadMiniPage from './pages/UploadMiniPage';
import EditMiniPage from './pages/EditMiniPage';
import AdminPage from './pages/AdminPage';
import ProfilePage from './pages/ProfilePage';
import CollectionPicker from './pages/CollectionPicker';
import CartPage from './pages/CartPage';
import LoansPage from './pages/LoansPage';
import NotificationBell from './components/NotificationBell';
import ChangePasswordForm from './components/ChangePasswordForm';

// ---------------------------------------------------------------------------
// Auth context
// The currently logged-in user (or null) is stored here and shared with every
// page in the app via the useAuth() hook, avoiding prop-drilling.
// ---------------------------------------------------------------------------

type AuthContextType = {
  user: User | null;
  loading: boolean;        // true while the initial /api/auth/me check is in flight
  setUser: (u: User | null) => void;
  collections: Collection[]; // the groups the current user belongs to
  selectCollection: (id: number) => Promise<void>;
  refreshSession: () => Promise<void>; // re-fetches user + collections from the server
  sessionNotice?: string; // why the user was just signed out, shown on the sign-in page
};

// Default context value — loading=true so pages don't flash the wrong state
export const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  setUser: () => {},
  collections: [],
  selectCollection: async () => {},
  refreshSession: async () => {},
});

// Convenience hook so any component can read the auth context without importing AuthContext
export function useAuth(): AuthContextType {
  return useContext(AuthContext);
}

// ---------------------------------------------------------------------------
// NavBar — only rendered when a user is logged in
// ---------------------------------------------------------------------------

function NavBar(): React.ReactElement | null {
  const { user, setUser, collections } = useAuth();
  const navigate = useNavigate();

  async function logout(): Promise<void> {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
    navigate('/login');
  }

  // Don't render the nav at all on the login/register pages
  if (!user) return null;

  const activeCollection = collections.find((c: Collection) => c.id === user.collectionId);

  // Clearing collectionId (client-side only) makes the top-level gate in
  // AppBody show the picker again — the actual switch still goes through
  // POST /api/auth/select-collection, which re-verifies membership.
  function switchCollection(): void {
    // Safe to assert — this is only reachable from a button rendered below
    // the `if (!user) return null;` guard above. The role goes too: it
    // belonged to the group being left.
    setUser({ ...user!, collectionId: undefined, role: 'user' });
    navigate('/');
  }

  return (
    <nav className="app-nav">
      <span className="app-nav-brand">
        ⚔ Mini Library
      </span>
      {activeCollection && (
        collections.length > 1 ? (
          <button
            type="button"
            onClick={switchCollection}
            style={{ background: 'none', border: 'none', color: '#8a7d6a', fontSize: '14px', cursor: 'pointer', padding: 0 }}
          >
            {activeCollection.name} (Switch)
          </button>
        ) : (
          <span style={{ color: '#8a7d6a', fontSize: '14px' }}>{activeCollection.name}</span>
        )
      )}
      <a href="/" style={{ color: '#e8e0d0', fontSize: '14px' }}>Browse</a>
      <a href="/upload" style={{ color: '#e8e0d0', fontSize: '14px' }}>Add Mini</a>
      <Link to="/cart" style={{ color: '#e8e0d0', fontSize: '14px' }}>Cart</Link>
      <Link to="/loans" style={{ color: '#e8e0d0', fontSize: '14px' }}>Loans</Link>
      {/* Admin link only appears for users with the admin role */}
      {user.role === 'admin' && (
        <a href="/admin" style={{ color: '#c9a84c', fontSize: '14px' }}>Admin</a>
      )}
      <NotificationBell collectionId={user.collectionId} />
      <Link to="/profile" style={{ color: '#8a7d6a', fontSize: '14px' }}>{user.username}</Link>
      <button className="btn-secondary" style={{ padding: '6px 14px', fontSize: '13px' }} onClick={logout}>
        Logout
      </button>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Route guards
// ---------------------------------------------------------------------------

// Wraps any route that requires login. Shows a spinner while the auth check
// is in flight, then either renders children or redirects to /login.
function PrivateRoute({ children }: { children: React.ReactNode }): React.ReactElement {
  const { user, loading } = useAuth();
  if (loading) {
    return <div style={{ padding: '40px', textAlign: 'center', color: '#8a7d6a' }}>Loading…</div>;
  }
  return user ? <>{children}</> : <Navigate to="/login" replace />;
}

// Wraps admin-only routes. Must be nested inside <PrivateRoute> so user is guaranteed non-null.
function AdminRoute({ children }: { children: React.ReactNode }): React.ReactElement | null {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user?.role === 'admin' ? <>{children}</> : <Navigate to="/" replace />;
}

// ---------------------------------------------------------------------------
// AppBody — decides between the loading spinner, the "pick a group" gate,
// and the normal app. Split out from App so it can call useAuth() (App
// itself provides the context, so it can't consume it in the same component).
// ---------------------------------------------------------------------------

function AppBody({ groupNotice, onDismissGroupNotice }: { groupNotice?: string; onDismissGroupNotice: () => void }): React.ReactElement {
  const { user, loading, collections, selectCollection, refreshSession } = useAuth();

  if (loading) {
    return <div style={{ padding: '40px', textAlign: 'center', color: '#8a7d6a' }}>Loading…</div>;
  }

  // An admin has given them a temporary password: nothing else until they
  // pick their own, so a password sent by text isn't left in use.
  if (user?.mustChangePassword) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
        <div style={{ background: '#252219', border: '1px solid #3d3629', borderRadius: '10px', padding: '32px 36px', width: '100%', maxWidth: '420px' }}>
          <h1 style={{ fontSize: '20px', color: '#c9a84c', marginBottom: '8px' }}>Choose a new password</h1>
          <p style={{ color: '#8a7d6a', fontSize: '13px', marginBottom: '22px' }}>
            You're signed in with a temporary password an admin set for you. Pick your own to carry on —
            enter the temporary one as your current password.
          </p>
          <ChangePasswordForm onChanged={() => void refreshSession()} />
        </div>
      </div>
    );
  }

  // Logged in, but no group selected yet — gate everything else on that
  // choice first, regardless of which URL they landed on.
  if (user && !user.collectionId) {
    if (collections.length === 0) {
      return (
        <div style={{ padding: '60px 24px', textAlign: 'center', color: '#8a7d6a' }}>
          <p style={{ fontSize: '18px', marginBottom: '8px' }}>You're not in any group yet.</p>
          <p style={{ fontSize: '14px' }}>Ask an admin to add your email to a group's invite list.</p>
        </div>
      );
    }
    return <CollectionPicker collections={collections} onSelect={(id: number) => void selectCollection(id)} />;
  }

  return (
    <>
      <NavBar />
      {groupNotice && (
        <div role="status" className="group-notice">
          <span>{groupNotice}</span>
          <button type="button" onClick={onDismissGroupNotice} aria-label="Dismiss">×</button>
        </div>
      )}
      {/* Keyed by group, so every page reloads its data when the group changes. */}
      <Routes key={user?.collectionId ?? 'none'}>
        {/* Public routes — accessible without logging in */}
        <Route path="/login"    element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* Protected routes — redirect to /login if not authenticated */}
        <Route path="/"              element={<PrivateRoute><DashboardPage /></PrivateRoute>} />
        <Route path="/upload"        element={<PrivateRoute><UploadMiniPage /></PrivateRoute>} />
        <Route path="/minis/:id/edit" element={<PrivateRoute><EditMiniPage /></PrivateRoute>} />
        <Route path="/profile"       element={<PrivateRoute><ProfilePage /></PrivateRoute>} />
        <Route path="/cart"          element={<PrivateRoute><CartPage /></PrivateRoute>} />
        <Route path="/loans"         element={<PrivateRoute><LoansPage /></PrivateRoute>} />

        {/* Admin route — requires both login and admin role */}
        <Route path="/admin"  element={<PrivateRoute><AdminRoute><AdminPage /></AdminRoute></PrivateRoute>} />

        {/* Catch-all: send anything unrecognised to the dashboard */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

// ---------------------------------------------------------------------------
// Root App component
// ---------------------------------------------------------------------------

export default function App(): React.ReactElement {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [sessionNotice, setSessionNotice] = useState<string | undefined>(undefined);

  // Loads the current session fresh from the server: who's logged in (from
  // the cookie) and which collections they belong to, auto-entering the one
  // group if that's all there is. Used both on first mount and right after
  // login/register — those pages call this instead of hand-building a User
  // object from their own response bodies, so the collectionId (and, for
  // registration, even the userId) always comes from the real source of
  // truth instead of possibly being stale or incomplete.
  async function refreshSession(): Promise<void> {
    try {
      const loadedUser = await api<User>('/api/auth/me');
      setUser(loadedUser);
      setSessionNotice(undefined);
      try {
        const myCollections = await api<Collection[]>('/api/auth/collections');
        setCollections(myCollections);

        // Auto-enter when there's only one possible choice and none is
        // selected yet (covers a page refresh right after registering
        // into a single group, before the JWT picked one up).
        if (!loadedUser.collectionId && myCollections.length === 1) {
          await selectCollection(myCollections[0].id);
        }
      } catch {
        setCollections([]); // non-fatal — nav just won't show a group name
      }
    } catch {
      setUser(null); // 401 means not logged in — that's fine
    }
  }

  // On first load, ask the backend if we already have a valid session (cookie).
  // This restores the logged-in state after a page refresh without asking the user
  // to log in again — the JWT cookie handles it transparently.
  useEffect(() => {
    void refreshSession().finally(() => setLoading(false));
    // Once, on first load: refreshSession is re-created each render, and
    // re-running this would re-check the session on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Your role is per group, so entering a group also sets the role you hold
  // there — that's what decides whether the admin view is shown.
  async function selectCollection(id: number): Promise<void> {
    const updated = await api<{ collectionId: number; role: string }>('/api/auth/select-collection', {
      method: 'POST',
      json: { collectionId: id },
    });
    setUser((prev: User | null) => prev ? { ...prev, collectionId: updated.collectionId, role: updated.role } : prev);
  }

  // When the server says the session is over (logged out on another device,
  // idle too long, or expired), drop back to sign-in and say why — but only
  // for someone who was actually signed in.
  const userRef = useRef<User | null>(user);
  userRef.current = user;

  // Every request says which group this tab is showing (see api/client.ts).
  // Set during render, not in an effect, so a page's first request already carries it.
  setActiveGroup(user?.collectionId);

  // Another tab switched groups: catch this tab up, and say why the page changed.
  const [groupNotice, setGroupNotice] = useState<string | undefined>(undefined);
  useEffect(() => {
    async function onGroupChanged(): Promise<void> {
      if (!userRef.current) return;
      try {
        const loadedUser = await api<User>('/api/auth/me');
        const myCollections = await api<Collection[]>('/api/auth/collections');
        setCollections(myCollections);
        setUser(loadedUser);
        const name = myCollections.find((c: Collection) => c.id === loadedUser.collectionId)?.name ?? 'another group';
        setGroupNotice(`You switched to ${name} in another tab, so this tab switched too.`);
      } catch {
        // A failed check leaves things as they were; the next request will try again.
      }
    }
    const listener = (): void => void onGroupChanged();
    window.addEventListener(GROUP_CHANGED_EVENT, listener);
    return () => window.removeEventListener(GROUP_CHANGED_EVENT, listener);
  }, []);
  useEffect(() => {
    function onSessionEnded(event: Event): void {
      if (!userRef.current) return;
      setSessionNotice((event as CustomEvent<string>).detail || 'Your session has ended. Please sign in again.');
      setUser(null);
    }
    window.addEventListener(SESSION_ENDED_EVENT, onSessionEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onSessionEnded);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, setUser, collections, selectCollection, refreshSession, sessionNotice }}>
      <BrowserRouter>
        <AppBody groupNotice={groupNotice} onDismissGroupNotice={() => setGroupNotice(undefined)} />
      </BrowserRouter>
    </AuthContext.Provider>
  );
}
