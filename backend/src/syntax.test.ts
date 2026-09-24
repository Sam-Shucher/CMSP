import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';

// A test named it('shows on the owner's Loans page', ...) ends its string at
// the apostrophe, and the whole file stops parsing. It happened twice in two
// days, both times in an *.integration.test.ts file — which this suite never
// loads, so every unit test stayed green and the break only surfaced at lint.
//
// This parses every TypeScript file in the repo — integration tests and the
// Playwright specs included — so a file that can't even be read fails here,
// in the suite run most often. Parsing only, no type-checking: that's tsc's
// job, and doing it here would make this suite slow.

const REPO = path.join(__dirname, '../..');
const SCANNED = ['backend/src', 'frontend/src', 'tests'];
const SKIPPED = new Set(['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report']);

function typeScriptFilesIn(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : typeScriptFilesIn(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

// "file:line:col message" for each place the parser gave up.
function syntaxErrors(files: string[]): string[] {
  const program = ts.createProgram(files, { noLib: true, noResolve: true, noEmit: true, jsx: ts.JsxEmit.Preserve });
  return program.getSyntacticDiagnostics().map(d => {
    const where = d.file ? path.relative(REPO, d.file.fileName) : '?';
    const { line, character } = d.file && d.start !== undefined
      ? d.file.getLineAndCharacterOfPosition(d.start)
      : { line: -1, character: -1 };
    return `${where}:${line + 1}:${character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}

describe('every TypeScript file in the repo parses', () => {
  const files = SCANNED.flatMap(dir => typeScriptFilesIn(path.join(REPO, dir)))
    .concat(fs.readdirSync(REPO).filter(name => /\.tsx?$/.test(name)).map(name => path.join(REPO, name)));

  it('finds the files it is meant to check, integration tests and e2e specs among them', () => {
    const names = files.map(f => path.relative(REPO, f).replace(/\\/g, '/'));
    expect(names.some(n => n.endsWith('.integration.test.ts'))).toBe(true);
    expect(names.some(n => n.startsWith('tests/') && n.endsWith('.spec.ts'))).toBe(true);
    expect(names.some(n => n.startsWith('frontend/src/') && n.endsWith('.tsx'))).toBe(true);
  });

  it('has no syntax errors anywhere', () => {
    expect(syntaxErrors(files)).toEqual([]);
  });

  // The check itself, against the exact mistake that kept slipping through.
  it("catches an apostrophe inside a single-quoted test name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-library-syntax-'));
    try {
      const broken = path.join(dir, 'broken.integration.test.ts');
      fs.writeFileSync(broken, "it('still shows on the owner's Loans page', async () => {});\n");
      const fine = path.join(dir, 'fine.integration.test.ts');
      fs.writeFileSync(fine, "it(\"still shows on the owner's Loans page\", async () => {});\n");

      expect(syntaxErrors([broken])).not.toEqual([]);
      expect(syntaxErrors([fine])).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
