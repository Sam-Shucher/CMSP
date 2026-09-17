import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import authRouter from './routes/auth';
import minisRouter from './routes/minis';
import adminRouter from './routes/admin';
import usersRouter from './routes/users';
import cartRouter from './routes/cart';
import loansRouter from './routes/loans';
import { requireAuth } from './middleware/requireAuth';
import { requireImageAccess } from './middleware/requireImageAccess';
import { securityHeaders, uploadHeaders, blockCrossSiteWrites, jsonErrors } from './middleware/security';
import { uploadsDir as configuredUploadsDir } from './config';

// Builds the Express app without starting it or touching the database —
// kept separate from index.ts so tests can import it and run requests
// against it with supertest without opening a real DB connection or port.
// The options only exist so tests can serve scratch folders.
export function createApp(options: { frontendDist?: string; uploadsDir?: string } = {}): express.Express {
  const app = express();

  // Don't advertise "X-Powered-By: Express" to anyone probing the site.
  app.disable('x-powered-by');

  // The Cloudflare tunnel connects from this same machine; trusting only
  // loopback proxies means req.ip is the real visitor (used for rate limits),
  // while a visitor can't fake their address by sending the header themselves.
  app.set('trust proxy', 'loopback');

  app.use(securityHeaders);

  // Allow the frontend origin to send cookies cross-origin during development.
  // In production, FRONTEND_URL should be the actual domain (e.g. http://raspberrypi.local).
  app.use(cors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    credentials: true, // required so the browser sends our auth cookie
  }));

  app.use(blockCrossSiteWrites);

  // Parse JSON request bodies (used by login, register, etc.) — capped so a
  // huge body can't tie up the Pi.
  app.use(express.json({ limit: '100kb' }));

  // Parse cookies on every request so req.cookies.token is available in route handlers
  app.use(cookieParser());

  // Uploaded mini photos — only for logged-in members of the mini's collection,
  // served with headers that keep them inert images.
  const uploadsDir = options.uploadsDir ?? configuredUploadsDir();
  app.use('/uploads', requireAuth, requireImageAccess, uploadHeaders, express.static(uploadsDir, { dotfiles: 'deny', index: false }));

  // Mount routers — each handles a group of related endpoints
  app.use('/api/auth',  authRouter);   // /api/auth/login, /register, /logout, /me
  app.use('/api/minis', minisRouter);  // /api/minis (browse, upload, tags, edit)
  app.use('/api/admin', adminRouter);  // /api/admin/approved-emails, /users (admin only)
  app.use('/api/users', usersRouter);  // /api/users/me (view/edit own profile)
  app.use('/api/cart',  cartRouter);   // /api/cart (basket + checkout)
  app.use('/api/loans', loansRouter);  // /api/loans (negotiation, handoff, return)

  // In production the backend also serves the built React app, so the whole
  // site runs on a single port. During development the Vite dev server handles
  // the frontend instead (with its /api proxy pointing here).
  if (process.env.NODE_ENV === 'production') {
    const frontendDist = options.frontendDist ?? path.join(__dirname, '../../frontend/dist');
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

  app.use(jsonErrors);

  return app;
}
