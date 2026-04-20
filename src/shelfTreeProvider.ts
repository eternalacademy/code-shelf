import * as vscode from 'vscode';
import * as path from 'path';
import { ShelfManager, ShelfMeta } from './shelfManager';

export class ShelfTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly shelfName?: string,
    public readonly filePath?: string,
    public readonly timestamp?: number
  ) {
    super(label, collapsibleState);
    if (filePath && shelfName) {
      this.description = filePath;
      this.tooltip = `Shelved diff for ${filePath}`;
      this.command = {
        command: 'code-shelf.viewShelfDiff',
        title: 'View Diff',
        arguments: [shelfName, filePath]
      };
    } else if (shelfName) {
      this.description = timestamp ? new Date(timestamp).toLocaleString() : '';
      this.tooltip = `Shelf: ${shelfName}`;
      this.iconPath = new vscode.ThemeIcon('archive');
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
      // Root — show shelves
      const shelves = await this.manager.getShelves();
      if (shelves.length === 0) {
        return [new ShelfTreeItem('No shelves yet', vscode.TreeItemCollapsibleState.None)];
      }
      return shelves.map(s =>
        new ShelfTreeItem(
          s.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          s.name,
          undefined,
          s.timestamp
        )
      );
    }

    if (element.shelfName && !element.filePath) {
      // Shelf — show files
      const shelves = await this.manager.getShelves();
      const shelf = shelves.find(s => s.name === element.shelfName);
      if (!shelf) return [];

      return shelf.files.map(f =>
        new ShelfTreeItem(
          path.basename(f),
          vscode.TreeItemCollapsibleState.None,
          element.shelfName,
          f,
          shelf.timestamp
        )
      );
    }

    return [];
  }
}
