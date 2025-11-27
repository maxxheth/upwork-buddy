# Quick Reference: TypeScript Bookmarklet Structure

## Module Overview

### Core Modules

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| `types.ts` | Type definitions, interfaces, config | `JobInfo`, `ProfileState`, `AnalysisResponse`, `CONFIG` |
| `api.ts` | Backend API communication | `ApiClient` class |
| `state.ts` | State & cache management | `StateManager` class |
| `job-extractor.ts` | Extract job info from DOM | `JobExtractor` class |
| `utils.ts` | Shared utilities | `escapeHtml()`, `renderValue()`, `renderAnalysis()`, `getTimeAgo()` |
| `styles.ts` | CSS styles | `STYLES` constant, `injectStyles()` |

### UI Components

| Component | Purpose | Key Methods |
|-----------|---------|-------------|
| `ui/modal.ts` | Modal dialog | `Modal.open()`, `Modal.close()`, `Modal.setContent()` |
| `ui/buttons.ts` | Floating action buttons | `ButtonManager.showAnalyzeButton()` |
| `ui/profile-config.ts` | Profile configuration form | `ProfileConfigUI.render()` |
| `ui/projects-list.ts` | Cached projects list | `ProjectsListUI.render()`, `ProjectsListUI.updateBadge()` |

### Main Entry Point

| Module | Purpose |
|--------|---------|
| `main.ts` | Initialize app, wire up components, handle user actions |

## Common Tasks

### Adding a New API Endpoint

1. Add types to `types.ts` (request/response interfaces)
2. Add method to `ApiClient` in `api.ts`
3. Call from appropriate UI component or main handler

### Modifying the Modal

1. Edit `ui/modal.ts` for structure/behavior
2. Edit `styles.ts` for styling

### Adding Profile Fields

1. Update `ProfileState` interface in `types.ts`
2. Update `ProfileConfigUI.render()` in `ui/profile-config.ts` to add form fields
3. Update `gatherProfile()` in same file to capture values
4. Update API payload in `api.ts` if needed

### Changing Job Extraction Logic

1. Edit `job-extractor.ts`
2. Modify selectors in `extractJobInfo()` method
3. Update `JobInfo` interface in `types.ts` if adding fields

### Adding New UI Component

1. Create `ui/new-component.ts`
2. Export class with constructor taking dependencies
3. Implement `render()` method
4. Import and instantiate in `main.ts`

## Build Commands

```bash
# Install dependencies
npm install

# Type check
npm run type-check

# Development build (with source maps)
npm run build:dev

# Production build (minified)
npm run build

# Watch mode (auto-rebuild on changes)
npm run watch
```

## File Naming Conventions

- **Classes**: PascalCase (e.g., `ApiClient`, `StateManager`)
- **Files**: kebab-case (e.g., `job-extractor.ts`, `profile-config.ts`)
- **Interfaces**: PascalCase (e.g., `JobInfo`, `ProfileState`)
- **Functions**: camelCase (e.g., `escapeHtml`, `renderAnalysis`)

## Import Patterns

```typescript
// Types (use `type` import)
import type { JobInfo, ProfileState } from './types';

// Constants/config
import { CONFIG } from './types';

// Classes
import { ApiClient } from './api';
import { StateManager } from './state';

// Functions
import { escapeHtml, renderAnalysis } from './utils';
```

## Testing Changes

1. Make changes in `src/`
2. Run `npm run build`
3. Check compiled output: `js/dist/upwork-buddy-snippet.js`
4. Test in browser with compiled bookmarklet

## Debugging

### Type Errors
```bash
npm run type-check
```

### Runtime Errors
```bash
# Build with source maps
npm run build:dev

# Compiled output will reference original TS files in stack traces
```

### Build Errors
- Check `tsconfig.json` for compiler options
- Verify all imports are correct
- Ensure esbuild can resolve all modules

## State Management Flow

```
User Action
    ↓
UI Component (buttons, modal)
    ↓
Handler in main.ts
    ↓
StateManager (read/write state)
    ↓
ApiClient (if server sync needed)
    ↓
Update UI
```

## Best Practices

1. **Keep modules focused**: One responsibility per file
2. **Use types everywhere**: Avoid `any`, use proper interfaces
3. **Export only what's needed**: Don't pollute module namespace
4. **Update types first**: When adding features, start with `types.ts`
5. **Test incrementally**: Build after each change to catch errors early
