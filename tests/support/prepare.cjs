// Runs before the app server starts (see playwright.config.ts): rebuilds the
// end-to-end database and clears old test uploads.
const fs = require('fs');
const { recreateDatabase, UPLOADS_DIR } = require('./seed.cjs');

recreateDatabase()
  .then(() => {
    fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    console.log('End-to-end database ready.');
  })
  .catch(err => {
    console.error(err.message);
    process.exit(1);
  });
