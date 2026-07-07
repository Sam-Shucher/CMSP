import 'dotenv/config'; // loads .env file into process.env before anything else
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { verifyConnection } from './db/connection';
import authRouter from './routes/auth';
import minisRouter from './routes/minis';
import adminRouter from './routes/admin';

const app = express();
const PORT = process.env.PORT ?? 3001;

// Allow the frontend origin to send cookies cross-origin during development.
// In production, FRONTEND_URL should be the actual domain (e.g. http://raspberrypi.local).
app.use(cors({
  origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  credentials: true, // required so the browser sends our auth cookie
}));

// Parse JSON request bodies (used by login, register, etc.)
app.use(express.json());

// Parse cookies on every request so req.cookies.token is available in route handlers
app.use(cookieParser());

// Serve uploaded mini images as static files — /uploads/filename.jpg maps to backend/uploads/
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Mount routers — each handles a group of related endpoints
app.use('/api/auth',  authRouter);   // /api/auth/login, /register, /logout, /me
app.use('/api/minis', minisRouter);  // /api/minis (browse, upload, tags)
app.use('/api/admin', adminRouter);  // /api/admin/approved-emails, /users (admin only)

// In production the backend also serves the built React app, so the whole
// site runs on a single port. During development the Vite dev server handles
// the frontend instead (with its /api proxy pointing here).
if (process.env.NODE_ENV === 'production') {
  const frontendDist = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist));
  // SPA fallback: any non-API GET request gets index.html so React Router
  // can handle the route client-side (e.g. a hard refresh on /minis/42).
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
      return next();
    }
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// Verify the database is reachable before accepting traffic.
// process.exit(1) stops the server entirely if the DB isn't available.
verifyConnection()
  .then(() => {
    app.listen(PORT, () => console.log(`Mini Library API running on port ${PORT}`));
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Failed to connect to database:', message);
    process.exit(1);
  });
