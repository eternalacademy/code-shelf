# Code Shelf v1.1.0 — Feature Plan

## Research Summary

### VS Code SCM API Context Menus
VS Code provides these menu contribution points for source control:
- `scm/title` — top-level SCM title bar (where our existing buttons are)
- `scm/resourceGroup/context` — right-click on resource groups (like "Changes", "Staged Changes")
- `scm/resourceState/context` — right-click on individual files within groups
- `editor/title` — editor title bar actions

We can add commands to these menus with `when` clauses to target specific SCM providers (e.g., `scmProvider == git`).

### IntelliJ Shelf Tab Features
- Dedicated tab in the Commit tool window
- Shows list of shelves, each expandable to show files
- Right-click context menu: Unshelve, Delete, Rename, Browse Changes
- Can unshelve into a specific changelist
- Shelf diff preview
- Combined Stash + Shelf view option

---

## Changes Plan

### 1. Source Control Context Menu Actions
**Files:** `package.json` (menus), `src/extension.ts`

Add commands to appear when right-clicking files in the Source Control panel:
- **"Shelve This File"** — appears on individual files (`scm/resourceState/context`)
- **"Shelve Selected Files"** — appears when multiple files selected
- **"Shelve All Changes"** — appears on the Changes group (`scm/resourceGroup/context`)
- **"Shelve Staged Changes"** — NEW: shelves only `git diff --cached` files

New commands:
- `code-shelf.shelveStaged` — shelve only staged changes (uses `git diff --cached`)
- `code-shelf.shelveFile` — shelve a single file from context menu
- `code-shelf.shelveSelected` — shelve selected files from multi-select

### 2. Enhanced Shelf Panel in Source Control
**Files:** `src/shelfTreeProvider.ts`, `src/extension.ts`

Improve the existing tree view to be more IntelliJ-like:
- **Shelves as expandable nodes** showing their files underneath
- **File-level actions:** right-click a file in a shelf to unshelve just that file, view diff, or delete
- **Shelf-level actions:** right-click a shelf to rename, unshelve, or delete
- **Timestamp + description** shown on each shelf node
- **Empty state** message when no shelves exist
- **Auto-refresh** when shelves change

### 3. Shelve Staged Changes Logic
**Files:** `src/shelfManager.ts`

New methods:
- `getStagedFiles()` — `git diff --cached --name-only`
- `shelveStaged(name)` — saves `git diff --cached` patches, then `git reset HEAD` to unstage
- `unshelveFile(shelfName, file)` — restore a single file from a shelf

### 4. Logo / Icon
**File:** `media/icon.png` (128x128 or larger)

Design a shelf/bookshelf icon — something recognizable as "shelving" code:
- A bookshelf or shelf metaphor
- Colors: blue/purple (matches VS Code theme well)
- Clean, simple SVG-style icon

### 5. LICENSE File
**File:** `LICENSE`

Add MIT license (matches README).

### 6. Version Bump
`package.json`: version `1.0.0` → `1.1.0`

---

## Execution Order
1. Add MIT LICENSE file
2. Generate icon
3. Update `shelfManager.ts` with staged file support + single-file unshelve
4. Update `shelfTreeProvider.ts` with enhanced tree (file nodes, context menus)
5. Update `extension.ts` with new commands and registrations
6. Update `package.json` with new commands, menus, version bump, icon
7. Run tests, build VSIX
8. Commit and push
