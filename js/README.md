# Upwork Buddy Browser Extension

A modular, TypeScript-based browser extension that injects Upwork Buddy directly into Upwork job pages for AI-assisted analysis.

## Project Structure

```
js/
├── src/                     # TypeScript sources (content script + UI)
├── dist/                    # Build output (content.js, manifest, icons)
├── icons/                   # Source icons copied into dist
├── manifest.json            # Extension manifest (MV3 + Firefox settings)
├── package.json
├── scripts/                 # Build helpers (esbuild orchestration)
├── tsconfig.json
└── README.md
```

## Setup

1. Install dependencies:
   ```bash
   cd js
   npm install
   ```

2. Build the extension bundle:
   ```bash
   npm run build
   ```

   For development with source maps:
   ```bash
   npm run build:dev
   ```

   For auto-rebuild on file changes:
   ```bash
   npm run watch
   ```

## Development

The TypeScript codebase is organized into logical modules:

- **API Layer** (`api.ts`): All backend communication
- **State Management** (`state.ts`): Profile and cache management using the extension storage adapter
- **Job Extraction** (`job-extractor.ts`): DOM parsing logic
- **UI Components** (`ui/`): Modular UI components (modal, buttons, config, projects)
- **Utils** (`utils.ts`): Shared utility functions
- **Types** (`types.ts`): TypeScript interfaces and configuration

### Type Checking

Run TypeScript type checking without emitting files:
```bash
npm run type-check
```

### Building

`npm run build` executes `scripts/build-extension.mjs`, which:

- Bundles `src/main.ts` and dependencies with esbuild into `dist/content.js`
- Emits source maps in dev mode (`npm run build:dev` / `npm run watch`)
- Copies `manifest.json` and the `icons/` directory into `dist/`

Final output: `dist/` contains everything needed to load the extension (manifest, icons, bundled script, and optional source map).

## Loading the Extension

### Chrome (MV3)

1. Run `npm run build` or `npm run build:dev`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the `js/dist` directory

### Firefox

1. Run `npm run build`
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on...** and choose `js/dist/manifest.json`

Firefox uses the `browser_specific_settings.gecko` block inside `manifest.json`. Update the `id` before submission to AMO.

## Host Permissions

The manifest currently whitelists:

- `https://www.upwork.com/*` – where the content script runs
- `http://localhost:9090/*` – default Upwork Buddy API base URL

If you deploy the API elsewhere, adjust `host_permissions` (and `CONFIG.apiBaseUrl`) accordingly, then rebuild.

## Features

- ✅ Fully typed with TypeScript
- ✅ Modular architecture (easy to reason about and modify)
- ✅ Separated concerns (API, state, UI, extraction)
- ✅ Single-file bundle output
- ✅ Fast builds with esbuild
- ✅ Development mode with source maps

## Usage

After running a build, load the unpacked extension (instructions above) and navigate to an Upwork job post. The floating Upwork Buddy controls and modal should appear automatically.
