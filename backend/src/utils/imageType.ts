// What an uploaded file really is, from its first bytes — the browser's claimed
// type comes from the file's name, so a text file renamed "photo.png" claims to
// be a PNG. Returns the extension to save it with, or null if it isn't one of
// the image formats we accept.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Enough bytes to tell every accepted format apart.
export const IMAGE_HEADER_BYTES = 12;

export function detectImageType(head: Buffer): '.jpg' | '.png' | '.gif' | '.webp' | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return '.png';
  const ascii = head.toString('latin1');
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return '.gif';
  if (head.length >= 12 && ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return '.webp';
  return null;
}
