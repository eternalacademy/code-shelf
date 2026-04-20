import * as vscode from 'vscode';
import { ShelfManager } from './shelfManager';
import { ShelfTreeProvider, ShelfTreeItem } from './shelfTreeProvider';

let manager: ShelfManager;
let treeProvider: ShelfTreeProvider;

export function activate(context: vscode.ExtensionContext) {
  try {
    manager = new ShelfManager(context);
  } catch {
    return;
  }

  treeProvider = new ShelfTreeProvider(manager);
  const treeView = vscode.window.createTreeView('code-shelf-view', {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(treeView);

  // ─── Shelve Changes ───
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

  // ─── Silent Shelve ───
  context.subscriptions.push(
    vscode.commands.registerCommand('code-shelf.silentShelve', async () => {
      const modified = await manager.getModifiedFiles();
      if (modified.length === 0) {
        vscode.window.showInformationMessage('No modified files to shelve.');
        return;
      }

      const name = `silent-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const success = await manager.shelve(modified, name, undefined, 'silent');
      if (success) {
        vscode.window.showInformationMessage(`Silently shelved ${modified.length} file(s) as "${name}"`);
        treeProvider.refresh();
      }
    })
  );

  // ─── Shelve Staged Changes ───
  context.subscriptions.push(
    vscode.commands.registerCommand('code-shelf.shelveStaged', async () => {
      const staged = await manager.getStagedFiles();
      if (staged.length === 0) {
        vscode.window.showInformationMessage('No staged changes to shelve.');
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: 'Shelf name for staged changes',
        placeHolder: 'staged-shelf',
        value: `staged-${Date.now()}`
      });
      if (!name) return;

      const success = await manager.shelve(staged, name, undefined, 'staged');
      if (success) {
        vscode.window.showInformationMessage(`Shelved ${staged.length} staged file(s) as "${name}"`);
        treeProvider.refresh();
      }
    })
  );

  // ─── Shelve Single File (from SCM context menu) ───
  context.subscriptions.push(
    vscode.commands.registerCommand('code-shelf.shelveFile', async (...args: any[]) => {
      const files: string[] = [];
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

      for (const arg of args) {
        if (arg?.uri?.fsPath) {
          const rel = path.relative(root, arg.uri.fsPath).replace(/\\/g, '/');
          if (rel) files.push(rel);
        } else if (arg?.resourceUri?.fsPath) {
          const rel = path.relative(root, arg.resourceUri.fsPath).replace(/\\/g, '/');
          if (rel) files.push(rel);
        }
      }

      if (files.length === 0) {
        const modified = await manager.getModifiedFiles();
        if (modified.length === 0) {
          vscode.window.showInformationMessage('No modified files to shelve.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          modified.map(f => ({ label: f })),
          { canPickMany: true, placeHolder: 'Select files to shelve' }
        );
        if (!picked || picked.length === 0) return;
        files.push(...picked.map(p => p.label));
      }

      const name = await vscode.window.showInputBox({
        prompt: 'Shelf name',
        placeHolder: 'my-shelf',
        value: `shelf-${Date.now()}`
      });
      if (!name) return;

      const success = await manager.shelve(files, name);
      if (success) {
        vscode.window.showInformationMessage(`Shelved ${files.length} file(s) as "${name}"`);
        treeProvider.refresh();
      }
    })
  );

  // ─── Unshelve ───
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

  // ─── Unshelve Single File ───
  context.subscriptions.push(
    vscode.commands.registerCommand('code-shelf.unshelveFile', async (item?: ShelfTreeItem) => {
      if (!item?.shelfName || !item?.filePath) {
        vscode.window.showWarningMessage('Select a file from a shelf to unshelve.');
        return;
      }

      const success = await manager.unshelveFile(item.shelfName, item.filePath);
      if (success) {
        vscode.window.showInformationMessage(`Unshelved "${item.filePath}" from "${item.shelfName}"`);
        treeProvider.refresh();
      }
    })
  );

  // ─── Delete Shelf ───
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

  // ─── Rename Shelf ───
  context.subscriptions.push(
    vscode.commands.registerCommand('code-shelf.renameShelf', async (item?: ShelfTreeItem) => {
      const oldName = item?.shelfName || await pickShelf();
      if (!oldName) return;

      const newName = await vscode.window.showInputBox({
        prompt: `Rename shelf "${oldName}" to:`,
        value: oldName
      });
      if (!newName || newName === oldName) return;

      const success = await manager.renameShelf(oldName, newName);
      if (success) {
        vscode.window.showInformationMessage(`Renamed "${oldName}" to "${newName}"`);
        treeProvider.refresh();
      }
    })
  );

  // ─── View Diff ───
  context.subscriptions.push(
    vscode.commands.registerCommand('code-shelf.viewShelfDiff', async (...args: any[]) => {
      // Args can be: [shelfName, filePath] from tree command, or [ShelfTreeItem] from context menu
      let shelfName: string | undefined;
      let filePath: string | undefined;

      for (const arg of args) {
        if (arg instanceof ShelfTreeItem) {
          shelfName = arg.shelfName;
          filePath = arg.filePath;
        } else if (typeof arg === 'string') {
          if (!shelfName) { shelfName = arg; }
          else if (!filePath) { filePath = arg; }
        }
      }

      const name = shelfName || await pickShelf();
      if (!name) return;

      const diff = manager.getShelfDiff(name, filePath);
      if (!diff) {
        vscode.window.showInformationMessage('No diff content.');
        return;
      }

      const title = filePath ? `${name} — ${path.basename(filePath)}` : `${name} — diff`;
      const doc = await vscode.workspace.openTextDocument({
        content: diff,
        language: 'diff'
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  // ─── Refresh Tree ───
  context.subscriptions.push(
    vscode.commands.registerCommand('code-shelf.refresh', () => {
      treeProvider.refresh();
    })
  );

  // ─── Helper ───
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
        description: `${s.files.length} file(s)`,
        detail: new Date(s.timestamp).toLocaleString()
      })),
      { placeHolder: 'Select a shelf' }
    );
    return picked?.label;
  }
}

import * as path from 'path';

export function deactivate() {}
