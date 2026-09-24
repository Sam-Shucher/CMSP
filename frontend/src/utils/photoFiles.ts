import { LIMITS } from '../limits';

// Checks a picked photo before anything is uploaded, so problems are explained
// right away — not after a long upload is refused. The server checks again.
//
// It also shrinks it first. A phone photo is 3–5 MB and 12 megapixels, and
// the app shows it at a few hundred pixels: thirty of those on the browse page
// was 100 MB+ over cellular and enough for mobile Safari to kill the tab.
// Doing it here costs the Pi nothing and makes the upload itself much faster.

export const ACCEPTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const MAX_PHOTO_BYTES = LIMITS.photoBytes;

// The longest side a photo is kept at. The detail view is at most ~900px
// wide; this leaves room for a sharp picture on a high-density screen.
export const PHOTO_MAX_SIDE = 1600;
// A photo already within PHOTO_MAX_SIDE and under this is sent as it is —
// re-encoding it would only lose a little quality for a little size.
export const KEEP_AS_IS_BYTES = 1024 * 1024;
const QUALITY = 0.85;

export type CheckedPhoto = { file: File; problem: string | null };

// What's wrong with the file's type alone — nothing that shrinking could fix.
function typeProblem(file: File): string | null {
  if (/^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) {
    return `"${file.name}" is an iPhone HEIC photo, which browsers can't show. Share or email it to yourself as a JPG first, or pick it from Photos on the phone itself — it converts automatically.`;
  }
  if (!ACCEPTED_PHOTO_TYPES.includes(file.type.toLowerCase())) {
    return `"${file.name}" isn't a JPG, PNG, GIF, or WebP photo.`;
  }
  return null;
}

// Returns what's wrong with the file, or null if it's a usable photo.
async function photoProblem(file: File): Promise<string | null> {
  const wrongType = typeProblem(file);
  if (wrongType) return wrongType;
  if (file.size > MAX_PHOTO_BYTES) {
    return `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — photos must be 10 MB or smaller.`;
  }
  // A text file renamed .png claims to be a PNG; only decoding it tells.
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      bitmap.close();
    } catch {
      return `"${file.name}" doesn't look like a photo we can open.`;
    }
  }
  return null;
}

// Shrinks the photos, then checks them — the size cap is on what's uploaded,
// so a big phone photo is fine once it's been shrunk. One at a time, on
// purpose: each full-size photo takes ~48 MB of memory to decode, and a pile
// dropped on Bulk Add all at once would take a phone's tab down with it.
export async function preparePhotos(files: File[]): Promise<CheckedPhoto[]> {
  const checked: CheckedPhoto[] = [];
  for (const original of files) {
    const wrongType = typeProblem(original);
    const file = wrongType ? original : await shrinkPhoto(original);
    checked.push({ file, problem: wrongType ?? await photoProblem(file) });
  }
  return checked;
}

// Just the shrinking, one at a time — for photos the server checks alone
// (a loan's condition photos).
export async function shrinkPhotos(files: File[]): Promise<File[]> {
  const shrunk: File[] = [];
  for (const file of files) shrunk.push(await shrinkPhoto(file));
  return shrunk;
}

// The photo redrawn with its longest side at most PHOTO_MAX_SIDE — or the
// original, whenever that's the better thing to send: already small, a GIF
// (redrawing keeps only its first frame), not something this browser can
// read (the checks after this will say so), or no smaller once redrawn.
//
// It's drawn from an <img>, which every current browser turns the right way
// up from the camera's orientation tag — so a phone photo taken sideways
// isn't uploaded sideways.
export async function shrinkPhoto(file: File): Promise<File> {
  // No createImageBitmap means nowhere to draw one (an old browser, or tests).
  if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') return file;

  const url = URL.createObjectURL(file);
  const canvas = document.createElement('canvas');
  try {
    const image = new Image();
    image.src = url;
    await image.decode();

    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    if (scale === 1 && file.size <= KEEP_AS_IS_BYTES) return file;

    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    // A photo stays a JPEG. Anything else becomes WebP, which keeps a PNG's
    // see-through parts; a browser that can't make WebP hands back a PNG.
    const wanted = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, wanted, QUALITY));
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], renamedFor(file.name, blob.type), { type: blob.type, lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
    // Safari caps the memory all canvases may hold; give this one's back now.
    canvas.width = 0;
    canvas.height = 0;
  }
}

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Same name, with the extension of what it now is ("cutout.png" → "cutout.webp").
function renamedFor(name: string, type: string): string {
  const extension = EXTENSIONS[type];
  if (!extension || type === 'image/jpeg') return name;
  const base = name.replace(/\.[^.]+$/, '');
  return `${base}.${extension}`;
}
