# Code Shelf ⚡

IntelliJ-style **Shelve Changes** for VS Code — a lightweight alternative to `git stash`.

## Why?

- `git stash` is global — you can't selectively stash individual files easily
- Stashes live in git reflog — they pollute your repo history
- IntelliJ's "Shelve Changes" is local, per-file, and silent — exactly what you need when you just want to quickly park some changes before pulling

**Code Shelf** stores patches in VS Code's workspace storage (hidden from file explorer and search) and lets you shelve/unshelve individual files or all changes with zero git side effects.

## Features

- **Shelve Changes** — Pick specific files to shelve, name your shelf
- **Silent Shelve** — One-click shelve all changes with auto-generated name
- **Unshelve** — Restore any shelf back to your working tree
- **Delete Shelf** — Remove old shelves
- **View Diff** — Preview shelved changes
- **Sidebar Tree View** — See all shelves and their files in the Source Control panel
- Handles both modified tracked files (via patch) and new untracked files

## Usage

1. Make some changes
2. Open Command Palette → `Code Shelf: Shelve Changes`
3. Select files → name the shelf → done
4. Changes are reverted and stored safely
5. When ready: `Code Shelf: Unshelve` to bring them back

For quick parking before a pull: `Code Shelf: Silent Shelve` — no prompts, instant.

## Commands

| Command | Description |
|---------|-------------|
| `Code Shelf: Shelve Changes` | Select files and name a shelf |
| `Code Shelf: Silent Shelve` | Shelve everything instantly |
| `Code Shelf: Unshelve` | Restore a shelf |
| `Code Shelf: Delete Shelf` | Remove a shelf |
| `Code Shelf: View Shelf Diff` | Preview shelved changes |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `code-shelf.enabled` | `true` | Enable Code Shelf extension |

## vs git stash

| | Code Shelf | git stash |
|---|---|---|
| Selective files | ✅ | ❌ (whole tree) |
| Stored in git | ❌ (local only) | ✅ (reflog) |
| Silent/quick | ✅ | Needs flags |
| Browseable UI | ✅ (sidebar) | ❌ |
| Untracked files | ✅ | Only with `-u` |

## License

MIT
