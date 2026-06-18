# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server (HMR, typically http://localhost:5173)
npm run build     # Type-check with tsc, then bundle for production (output: dist/)
npm run preview   # Serve the production build locally
npx prettier --write .  # Format all files
```

There are no test commands — this project has no test suite.

## Architecture

A minimal TypeScript + Vite single-page counter app scaffolded by JetBrains WebStorm. No runtime dependencies; only `typescript`, `vite`, and `prettier` as devDependencies.

- `index.html` — HTML entry point; counter UI is defined here with button elements
- `src/main.ts` — sole source file; queries the DOM and wires up counter logic with `+1`, `+2`, `-1`, `-2` buttons; counter value wraps within `[-99, 99]`
- `public/` — static assets (SVGs, fonts, `style.css`); served as-is by Vite

TypeScript is configured in strict mode (`strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`). Prettier uses single quotes, 2-space indent, 80-char print width.

## Known Incomplete Code

The `-2` button in `src/main.ts` (lines 24–25) is missing its event listener callback — it was intentionally left incomplete as a WebStorm learning exercise. The inline comments explain the expected behavior.
