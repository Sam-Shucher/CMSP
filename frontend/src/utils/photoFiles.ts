// Checks a picked photo before anything is uploaded, so problems are explained
// right away — not after a long upload is refused. The server checks again.

export const ACCEPTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// Returns what's wrong with the file, or null if it's a usable photo.
export async function photoProblem(file: File): Promise<string | null> {
  if (/^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) {
    return `"${file.name}" is an iPhone HEIC photo, which browsers can't show. Share or email it to yourself as a JPG first, or pick it from Photos on the phone itself — it converts automatically.`;
  }
  if (!ACCEPTED_PHOTO_TYPES.includes(file.type.toLowerCase())) {
    return `"${file.name}" isn't a JPG, PNG, GIF, or WebP photo.`;
  }
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
