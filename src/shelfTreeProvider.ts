import * as vscode from 'vscode';
import * as path from 'path';
import { ShelfManager, ShelfMeta } from './shelfManager';

export class ShelfTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly shelfName?: string,
    public readonly filePath?: string,
    public readonly meta?: ShelfMeta,
    public readonly integrityStatus?: 'ok' | 'no-manifest' | 'unknown'
  ) {
    super(label, collapsibleState);

    if (filePath && shelfName) {
      this.description = filePath;
      this.tooltip = `Shelved: ${filePath}`;
      this.iconPath = vscode.ThemeIcon.File;
      this.contextValue = 'shelfFile';
      this.command = {
        command: 'code-shelf.viewShelfDiff',
        title: 'View Diff',
        arguments: [shelfName, filePath]
      };
    } else if (shelfName && meta) {
      const fileCount = meta.files.length;
      const time = new Date(meta.timestamp).toLocaleString();
      const typeIcon = meta.type === 'staged' ? 'git-commit' : meta.type === 'silent' ? 'zap' : 'archive';
      const typeLabel = meta.type === 'staged' ? 'Staged' : meta.type === 'silent' ? 'Silent' : '';

      let integrityBadge = '';
      if (integrityStatus === 'ok') {
        integrityBadge = ' ✓';
      } else if (integrityStatus === 'no-manifest') {
        integrityBadge = ' ⚠';
      }

      this.description = `${fileCount} file${fileCount !== 1 ? 's' : ''} · ${time}${integrityBadge}`;
      this.tooltip = `${typeLabel ? typeLabel + ' · ' : ''}${fileCount} file${fileCount !== 1 ? 's' : ''}\n${meta.description || ''}\nIntegrity: ${integrityStatus === 'ok' ? 'Verified' : integrityStatus === 'no-manifest' ? 'Legacy (no manifest)' : 'Unknown'}`;
      this.iconPath = new vscode.ThemeIcon(typeIcon);
      this.contextValue = 'shelf';
    }
  }
}

export class ShelfTreeProvider implements vscode.TreeDataProvider<ShelfTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ShelfTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: ShelfManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ShelfTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ShelfTreeItem): Promise<ShelfTreeItem[]> {
    if (!element) {
      const shelves = await this.manager.getShelves();
      if (shelves.length === 0) {
        return [new ShelfTreeItem(
          'No shelves yet — shelve some changes to get started',
          vscode.TreeItemCollapsibleState.None
        )];
      }
      return Promise.all(shelves.map(async s => {
        let status: 'ok' | 'no-manifest' | 'unknown' = 'unknown';
        try {
          const validation = await this.manager.validateShelfByName(s.name);
          if (validation) {
            status = validation.valid ? 'ok' : 'no-manifest';
          }
        } catch {
          status = 'unknown';
        }
        return new ShelfTreeItem(
          s.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          s.name,
          undefined,
          s,
          status
        );
      }));
    }

    if (element.shelfName && !element.filePath && element.meta) {
      const shelf = element.meta;
      return shelf.files.map(f =>
        new ShelfTreeItem(
          path.basename(f),
          vscode.TreeItemCollapsibleState.None,
          element.shelfName,
          f,
          shelf
        )
      );
    }

    return [];
  }
}
