// Runs before the app server starts (see playwright.config.ts): rebuilds the
// end-to-end database and clears old test uploads.
const fs = require('fs');
const path = require('path');
const { recreateDatabase, ROOT } = require('./seed.cjs');

recreateDatabase()
  .then(() => {
    fs.rmSync(path.join(ROOT, 'e2e/.uploads'), { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, 'e2e/.uploads'), { recursive: true });
    console.log('End-to-end database ready.');
  })
  .catch(err => {
    console.error(err.message);
    process.exit(1);
  });
