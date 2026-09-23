import { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { uploadsDir as configuredUploadsDir } from '../config';
import { detectImageType, IMAGE_HEADER_BYTES } from '../utils/imageType';

// The photo-upload pipeline, shared by the two things in this app that take
// photos: a mini (routes/minis.ts) and a loan's condition report
// (routes/loans.ts). Both save into the same folder and are served by the same
// /uploads route, so they have to agree on every rule here — which file types
// are allowed, what a saved file is named, and what happens to a file whose
// request then fails.

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // large enough for a camera photo

// The only file types accepted, and the extension each is saved with. SVG is
// deliberately absent — it's an "image" that can carry scripts.
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// Ensure the uploads directory exists when the server starts.
// Uploaded images live here and are served as static files by index.ts.
export const uploadsDir = configuredUploadsDir();
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Must run BEFORE multer. Photos are written to disk as the request arrives,
// before we know whether the request will be accepted — so if the response
// ends up being an error (not your mini, bad input, too many photos, a server
// error), delete whatever this request saved instead of leaving it behind.
export function discardUploadsIfRejected(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    if (res.statusCode < 400) return;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    for (const file of files) {
      fs.rmSync(file.path, { force: true });
    }
  });
  next();
}

// diskStorage tells multer to save files to disk (vs keeping them in memory).
const storage = multer.diskStorage({
  destination: uploadsDir,
  // A unique, server-generated name. The extension comes from the checked
  // image type — NEVER the uploader's filename, or "evil.html" labelled as a
  // PNG would be saved as .html and served back as a live web page.
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cb(null, `${unique}${IMAGE_EXTENSIONS[file.mimetype.toLowerCase()]}`);
  },
});

// `field` is the multipart field name the files arrive under.
export function photoUpload(field: string, maxFiles: number): RequestHandler {
  return multer({
    storage,
    limits: {
      fileSize: MAX_PHOTO_BYTES,
      files: maxFiles,
      fields: 20,
      fieldSize: 100 * 1024,
    },
    fileFilter: (_req, file, cb) => {
      // Only accept images — reject PDFs, executables, SVGs, etc.
      if (IMAGE_EXTENSIONS[file.mimetype.toLowerCase()]) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed (jpg, png, gif, webp)'));
      }
    },
  }).array(field, maxFiles);
}

// Converts a multer/fileFilter error into a clean 400 JSON response instead
// of Express's default HTML error page. Placed right after photoUpload(...)
// in each route's middleware list — Express routes to it only when that
// middleware calls next(err). `tooManyMessage` names what the caller was
// attaching photos to, since that is what someone reading it needs to know.
export function handleUploadError(tooManyMessage: string): ErrorRequestHandler {
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (err instanceof multer.MulterError) {
      const tooMany = err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE';
      res.status(400).json({
        error: tooMany ? tooManyMessage
          : err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be 10 MB or smaller'
          : 'Invalid upload',
      });
      return;
    }
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  };
}

// Runs after multer has saved the files: checks each one really is an image
// (not, say, a text file renamed .png) and gives it the extension of what it
// actually is. Anything else is refused by name — and discardUploadsIfRejected
// then deletes everything this request saved.
export function verifyImageContents(req: Request, res: Response, next: NextFunction): void {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  for (const file of files) {
    const head = Buffer.alloc(IMAGE_HEADER_BYTES);
    const fd = fs.openSync(file.path, 'r');
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(fd, head, 0, IMAGE_HEADER_BYTES, 0);
    } finally {
      fs.closeSync(fd);
    }

    const ext = detectImageType(head.subarray(0, bytesRead));
    if (!ext) {
      const shownName = file.originalname.slice(0, 80);
      res.status(400).json({ error: `"${shownName}" isn't a photo we can open — use a JPG, PNG, GIF, or WebP` });
      return;
    }
    if (path.extname(file.filename) !== ext) {
      const renamed = `${path.basename(file.filename, path.extname(file.filename))}${ext}`;
      const renamedPath = path.join(path.dirname(file.path), renamed);
      fs.renameSync(file.path, renamedPath);
      file.filename = renamed;
      file.path = renamedPath;
    }
  }
  next();
}

// The path an uploaded file is stored and served under.
export function uploadPath(file: Express.Multer.File): string {
  return `/uploads/${file.filename}`;
}

// Best-effort removal of a file we stored — the hourly sweep
// (maintenance/housekeeping.ts) catches anything this misses.
export function deleteUpload(imagePath: string): void {
  fs.unlink(path.join(uploadsDir, path.basename(imagePath)), () => {});
}
