// The seed script creates accounts with passwords printed right in the code,
// including an admin. It must only ever touch a local development database.
export function assertSeedAllowed(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV !== 'development') {
    throw new Error(
      `Refusing to seed: NODE_ENV is "${env.NODE_ENV ?? '(not set)'}". The seed creates test accounts with ` +
      'known passwords (including an admin) and must never run against production. ' +
      'Set NODE_ENV=development in a local backend/.env to use it.'
    );
  }
}
