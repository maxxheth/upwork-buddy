---
name: add-frontend-feature
description: Add a new UI feature or component to the Upwork Buddy Chrome extension/bookmarklet. Use when the user wants to create a new UI panel, modal section, or interactive component in the frontend.
tools: Read, Edit, Write, Bash, Grep, Glob
model: inherit
maxTurns: 20
---

You are adding a new frontend feature to the Upwork Buddy browser extension. Follow the project's established conventions precisely.

## Architecture Context
- Frontend code lives in `js/src/` and is built with esbuild (`js/scripts/build-extension.mjs`).
- Entry point: `js/src/main.ts` — the `UpworkBuddy` class orchestrates everything.
- UI components are classes in `js/src/ui/` that accept a DOM container element in their constructor and render HTML into it. See `modal.ts`, `buttons.ts`, `profile-config.ts`, `projects-list.ts` for patterns.
- State management: `js/src/state.ts` — `StateManager` class holds profile and cache data, communicates with `ApiClient` for API calls and `StorageAdapter` for persistence.
- API client: `js/src/api.ts` — `ApiClient` class wraps `fetch()` calls to the Go backend.
- Types: `js/src/types.ts` — all interfaces and the `CONFIG` constant. Also contains `detectEnvironment()` and `loadConfig()`.
- Storage: `js/src/storage.ts` — `StorageAdapter` handles chrome.storage and localStorage fallback. Also has `getEnvOverride()`/`saveEnvOverride()` for environment switching.
- Job extraction: `js/src/job-extractor.ts` — `JobExtractor` scrapes job data from the Upwork DOM.
- Utils: `js/src/utils.ts` — `renderAnalysis()`, `escapeHtml()`, `getTimeAgo()`.
- Styles: `js/src/styles.ts` — `injectStyles()` adds a `<style>` block to the page.
- The build produces `js/dist/content.js` which is loaded as a Chrome content script.

## Conventions
- Use TypeScript classes, not functions or React components.
- Render HTML via template literals with `escapeHtml()` for any dynamic content.
- Use `CONFIG.apiBaseUrl` and `CONFIG.profileApiEndpoint` for API URLs (from types.ts).
- Log with emoji prefixes: ✅ success, ❌ error, 🔍 search, 📥 input, 📤 output.
- Handle both Chrome extension and bookmarklet contexts (StorageAdapter abstracts this).
- Never use `alert()` — use the Modal component for UI feedback.
- Use the `respondWithJSON` pattern for any new API endpoints.

## Steps
1. Read the existing UI files in `js/src/ui/` to absorb the component patterns.
2. Create a new file `js/src/ui/<feature-name>.ts` with a class that follows the established pattern:
   - Constructor takes dependencies (StateManager, DOM container, etc.)
   - A `render()` method that builds and inserts HTML
   - Event handlers wired via `addEventListener`
   - Proper error handling with user-friendly messages
3. If the feature needs persistence, add new storage keys to `StorageAdapter` following the existing pattern.
4. If the feature needs a backend API, add the API method to `ApiClient` and add any new types to `types.ts`.
5. Wire the new component into `main.ts` — instantiate it, add any necessary buttons via `ButtonManager`.
6. Add any new CSS rules to `styles.ts`.
7. Run `cd js && npm run type-check` to verify TypeScript compiles.
8. Run `cd js && npm run build` to verify the build succeeds.