import * as vscode from 'vscode';
import { ShelfManager } from './shelfManager';
import { ShelfTreeProvider, ShelfTreeItem } from './shelfTreeProvider';

let manager: ShelfManager;
let treeProvider: ShelfTreeProvider;

export function activate(context: vscode.ExtensionContext) {
  try {
    manager = new ShelfManager();
  } catch {
    return; // No workspace
  }

  treeProvider = new ShelfTreeProvider(manager);
  const treeView = vscode.window.createTreeView('code-shelf-view', {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(treeView);

  // Shelve Changes — select files, name the shelf
  context.subscriptions.push(
    vscode.commands.registerCommand('code-shelf.shelveChanges', async () => {
      const modified = await manager.getModifiedFiles();
      if (modified.length === 0) {
        vscode.window.showInformationMessage('No modified files to shelve.');
        return;
      }

      const selected = await vscode.window.showQuickPick(
        modified.map(f => ({ label: f, picked: true })),
        { canPickMany: true, placeHolder: 'Select files to shelve' }
      );
      if (!selected || selected.length === 0) return;

      const name = await vscode.window.showInputBox({
        prompt: 'Shelf name',
        placeHolder: 'my-shelf',
        value: `shelf-${Date.now()}`
      });
      if (!name) return;

      const success = await manager.shelve(selected.map(s => s.label), name);
      if (success) {
        vscode.window.showInformationMessage(`Shelved ${selected.length} file(s) as "${name}"`);
        treeProvider.refresh();
      }
    })
  );

  // Silent Shelve — all changes, auto-named
  context.subscriptions.push(
    vscode.commands.registerCommand('code-shelf.silentShelve', async () => {
      const modified = await manager.getModifiedFiles();
      if (modified.length === 0) {
        vscode.window.showInformationMessage('No modified files to shelve.');
        return;
      }

      const name = `silent-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const success = await manager.shelve(modified, name);
      if (success) {
        vscode.window.showInformationMessage(`Silently shelved ${modified.length} file(s) as "${name}"`);
        treeProvider.refresh();
      }
    })
  );

  // Unshelve
  context.subscriptions.push(
    vscode.commands.registerCommand('code-shelf.unshelve', async (item?: ShelfTreeItem) => {
      const name = await pickShelf(item?.shelfName);
      if (!name) return;

      const success = await manager.unshelve(name);
      if (success) {
        vscode.window.showInformationMessage(`Unshelved "${name}"`);
        treeProvider.refresh();
      }
    })
  );

  // Delete Shelf
  context.subscriptions.push(
    vscode.commands.registerCommand('code-shelf.deleteShelf', async (item?: ShelfTreeItem) => {
      const name = await pickShelf(item?.shelfName);
      if (!name) return;

      const confirm = await vscode.window.showWarningMessage(
        `Delete shelf "${name}"?`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') return;

      await manager.deleteShelf(name);
      vscode.window.showInformationMessage(`Deleted shelf "${name}"`);
      treeProvider.refresh();
    })
  );

  // View Diff
  context.subscriptions.push(
    vscode.commands.registerCommand('code-shelf.viewShelfDiff', async (shelfName?: string, filePath?: string) => {
      const name = shelfName || await pickShelf();
      if (!name) return;

      const diff = manager.getShelfDiff(name, filePath);
      if (!diff) {
        vscode.window.showInformationMessage('No diff content.');
        return;
      }

      const doc = await vscode.workspace.openTextDocument({
        content: diff,
        language: 'diff'
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  async function pickShelf(preselected?: string): Promise<string | undefined> {
    if (preselected) return preselected;
    const shelves = await manager.getShelves();
    if (shelves.length === 0) {
      vscode.window.showInformationMessage('No shelves found.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      shelves.map(s => ({
        label: s.name,
        description: new Date(s.timestamp).toLocaleString(),
        detail: `${s.files.length} file(s)`
      })),
      { placeHolder: 'Select a shelf' }
    );
    return picked?.label;
  }
}

export function deactivate() {}
