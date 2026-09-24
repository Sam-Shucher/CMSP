import { Response, RequestHandler } from 'express';
import { CollectionRequest } from '../middleware/requireCollectionMembership';

// Every route ends the same way: if something unexpected goes wrong, log it
// where the Pi's journal can show it and reply with a generic 500 — never a
// stack trace or a database message. This wrapper is that ending, written once.
//
//   router.get('/', route(async (req, res) => { res.json(await listThings()); }));
export function route(handler: (req: CollectionRequest, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    void handler(req as CollectionRequest, res).catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    });
  };
}

// A positive whole number from a URL, or null — anything else (a word, a
// negative, a float) simply matches nothing, so the caller replies 404.
export function idFrom(value: string | undefined): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// The mini's (or set's) owner, or an admin of this group — the people who may
// edit, delete, transfer or correct it. The role is the one
// requireCollectionMembership just read, so being an admin elsewhere counts for nothing.
export function ownerOrAdmin(req: CollectionRequest, ownerId: number): boolean {
  return ownerId === req.user!.userId || req.user!.role === 'admin';
}
