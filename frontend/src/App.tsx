import React, { createContext, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { api, User } from './api/client';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';
import UploadMiniPage from './pages/UploadMiniPage';
import AdminPage from './pages/AdminPage';

// ---------------------------------------------------------------------------
// Auth context
// The currently logged-in user (or null) is stored here and shared with every
// page in the app via the useAuth() hook, avoiding prop-drilling.
// ---------------------------------------------------------------------------

type AuthContextType = {
  user: User | null;
  loading: boolean;        // true while the initial /api/auth/me check is in flight
  setUser: (u: User | null) => void;
};

// Default context value — loading=true so pages don't flash the wrong state
export const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  setUser: () => {},
});

// Convenience hook so any component can read the auth context without importing AuthContext
export function useAuth(): AuthContextType {
  return useContext(AuthContext);
}

// ---------------------------------------------------------------------------
// NavBar — only rendered when a user is logged in
// ---------------------------------------------------------------------------

function NavBar(): React.ReactElement | null {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();

  async function logout(): Promise<void> {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
    navigate('/login');
  }

  // Don't render the nav at all on the login/register pages
  if (!user) return null;

  return (
    <nav style={{
      background: '#252219',
      borderBottom: '1px solid #3d3629',
      padding: '0 24px',
      display: 'flex',
      alignItems: 'center',
      gap: '24px',
      height: '56px',
    }}>
      <span style={{ fontFamily: 'Cinzel, serif', color: '#c9a84c', fontSize: '18px', marginRight: 'auto' }}>
        ⚔ Mini Library
      </span>
      <a href="/" style={{ color: '#e8e0d0', fontSize: '14px' }}>Browse</a>
      <a href="/upload" style={{ color: '#e8e0d0', fontSize: '14px' }}>Add Mini</a>
      {/* Admin link only appears for users with the admin role */}
      {user.role === 'admin' && (
        <a href="/admin" style={{ color: '#c9a84c', fontSize: '14px' }}>Admin</a>
      )}
      <span style={{ color: '#8a7d6a', fontSize: '14px' }}>{user.username}</span>
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
// Root App component
// ---------------------------------------------------------------------------

export default function App(): React.ReactElement {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // On first load, ask the backend if we already have a valid session (cookie).
  // This restores the logged-in state after a page refresh without asking the user
  // to log in again — the JWT cookie handles it transparently.
  useEffect(() => {
    api<User>('/api/auth/me')
      .then(setUser)
      .catch(() => setUser(null)) // 401 means not logged in — that's fine
      .finally(() => setLoading(false));
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, setUser }}>
      <BrowserRouter>
        <NavBar />
        <Routes>
          {/* Public routes — accessible without logging in */}
          <Route path="/login"    element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          {/* Protected routes — redirect to /login if not authenticated */}
          <Route path="/"       element={<PrivateRoute><DashboardPage /></PrivateRoute>} />
          <Route path="/upload" element={<PrivateRoute><UploadMiniPage /></PrivateRoute>} />

          {/* Admin route — requires both login and admin role */}
          <Route path="/admin"  element={<PrivateRoute><AdminRoute><AdminPage /></AdminRoute></PrivateRoute>} />

          {/* Catch-all: send anything unrecognised to the dashboard */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthContext.Provider>
  );
}
