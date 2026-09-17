import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The browser's built-in validation popups ("Please include an '@'…") pop up
// at odd moments and can't be styled or reworded. Every form handles its own
// messages instead (see hooks/useValidatedForm.ts), so every <form> must turn
// the browser's version off. This scans the source so a new form can't forget.

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [full] : [];
  });
}

describe('forms', () => {
  const files = sourceFiles(__dirname);

  it('the scan finds the app\'s forms', () => {
    const withForms = files.filter(f => /<form\b/.test(fs.readFileSync(f, 'utf8')));
    expect(withForms.map(f => path.basename(f))).toEqual(expect.arrayContaining([
      'LoginPage.tsx', 'RegisterPage.tsx', 'AdminPage.tsx', 'MiniForm.tsx', 'ProfilePage.tsx', 'LoanCard.tsx',
    ]));
  });

  it('every <form> turns off the browser\'s own validation popups (noValidate)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/<form\b[^>]*>/g)) {
        if (!/\bnoValidate\b/.test(match[0])) {
          offenders.push(`${path.relative(__dirname, file)}: ${match[0].slice(0, 60)}…`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
