// Prints a new VAPID key pair for phone notifications, as backend/.env lines.
// scripts/rpi-update.sh runs this once, when .env doesn't have a pair yet:
//
//   node backend/dist/maintenance/vapidKeys.js >> backend/.env
//
// Keep the pair once it's in use. A new one silently stops every phone that
// already said yes, until each next opens the app (frontend/src/push.ts's
// resyncPush then signs it up again under the new key).
import { generateVAPIDKeys } from 'web-push';

const { publicKey, privateKey } = generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
