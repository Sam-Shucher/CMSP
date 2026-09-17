import { Request, Response, NextFunction } from 'express';

// Content-Security-Policy for the web app itself. Scripts only from this site
// (so injected markup can't run code), no plugins, and no other site may put
// this app inside a frame (click-jacking the delete buttons). Styles and fonts
// also allow Google Fonts, which index.html loads; blob: images are the photo
// previews shown before an upload.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', APP_CSP);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    // The site is only ever reached over HTTPS through Cloudflare.
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
}

// Uploaded photos are user-supplied files. Even if one somehow contained
// markup, these headers make the browser treat it as an inert image: no
// sniffing it as HTML, and a sandbox that forbids scripts entirely.
export function uploadHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=86400'); // members only — never cached by a shared proxy
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Browsers stamp every request with Sec-Fetch-Site. A request that changes
// something must come from this site's own pages — never another website,
// including a sibling subdomain (which SameSite cookies alone don't block).
// Requests without the header (non-browser tools) still need a valid login.
export function blockCrossSiteWrites(req: Request, res: Response, next: NextFunction): void {
  const site = req.get('Sec-Fetch-Site');
  if (!SAFE_METHODS.has(req.method) && site && site !== 'same-origin' && site !== 'none') {
    res.status(403).json({ error: 'Cross-site request blocked' });
    return;
  }
  next();
}

// Final error handler: clean JSON for bad request bodies, and a generic 500
// for anything unexpected — never a stack trace or library internals.
export function jsonErrors(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  // Express's body parser attaches `type` and `status` to the errors it throws.
  const { type, status } = (err ?? {}) as { type?: string; status?: number };
  if (type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }
  if (type === 'entity.too.large') {
    res.status(413).json({ error: 'Request too large' });
    return;
  }
  if (status === 400 || status === 403 || status === 404) {
    res.status(status).json({ error: 'Invalid request' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
}
