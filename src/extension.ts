import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { computeLineDiff } from './diff/diffEngine';
import { buildStructuralDiff } from './diff/structuralBuilder';
import {
  commitWorkingChanges,
  getCommitVersions,
  getFileVersions,
  getLocalBranchesSorted,
  getRepoRoot,
  isBinaryFile,
  switchBranch,
} from './git/gitService';
import { GitTreeDataProvider } from './sidebar/gitTreeDataProvider';
import { renderBinaryNoticeHtml, renderDiffHtml, renderDiffParts } from './ui/diffHtmlRenderer';

export function activate(context: vscode.ExtensionContext) {
  const getWorkspaceRoot = (): string | undefined => {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  };

  function registerCommand(name: string, handler: (...args: any[]) => any) {
    context.subscriptions.push(vscode.commands.registerCommand(`structuralDiff.${name}`, handler));
  }

  // 1. Initialize and register the Sidebar TreeDataProvider & TreeView
  const treeDataProvider = new GitTreeDataProvider(getWorkspaceRoot);
  const treeView = vscode.window.createTreeView('structuralDiffExplorer', {
    treeDataProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // 1.1 Live preview on keyboard (arrow keys) and mouse selection change
  let selectionDebounceTimer: NodeJS.Timeout | undefined;
  const selectionSub = treeView.onDidChangeSelection((e) => {
    if (!e.selection || e.selection.length === 0) return;
    const selected = e.selection[0];

    if (selectionDebounceTimer) {
      clearTimeout(selectionDebounceTimer);
      selectionDebounceTimer = undefined;
    }

    selectionDebounceTimer = setTimeout(() => {
      if (selected.kind === 'workingFile') {
        vscode.commands.executeCommand('structuralDiff.openDiff', vscode.Uri.file(selected.file.filePath), true);
      } else if (selected.kind === 'commitFile') {
        vscode.commands.executeCommand(
          'structuralDiff.openCommitDiff',
          vscode.Uri.file(selected.file.filePath),
          selected.commitHash,
          true
        );
      }
    }, 50);
  });
  context.subscriptions.push(selectionSub);

  // 2. Command to refresh the sidebar
  registerCommand('refreshExplorer', () => {
    treeDataProvider.refresh();
  });

  // 2.1 Command to checkout selected branch from tree item
  registerCommand('checkoutBranch', async (node: any) => {
    const branchName = node?.branchName;
    if (!branchName) return;
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return;
    const repoRoot = getRepoRoot(wsRoot);
    try {
      switchBranch(repoRoot, branchName);
      vscode.window.showInformationMessage(`Switched to branch: ${branchName}`);
      treeDataProvider.refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to switch branch: ${err.message}`);
    }
  });

  // 2.2 Command to load more commits for a branch
  registerCommand('loadMoreCommits', (branchName: string) => {
    if (branchName) {
      treeDataProvider.loadMoreCommits(branchName);
    }
  });

  // 2.3 Command to commit working changes
  registerCommand('commitChanges', async () => {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return;
    const repoRoot = getRepoRoot(wsRoot);

    const message = await vscode.window.showInputBox({
      prompt: 'Enter Git commit message',
      placeHolder: 'e.g. feat: add new feature or fix: resolve issue',
      validateInput: (text) => (!text.trim() ? 'Commit message cannot be empty' : null),
    });

    if (!message || !message.trim()) return;

    try {
      commitWorkingChanges(repoRoot, message.trim());
      vscode.window.showInformationMessage(`Committed: ${message.trim()}`);
      treeDataProvider.refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Commit failed: ${err.message}`);
    }
  });

  // 3. Command to switch branch
  registerCommand('switchBranch', async () => {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return;
    const repoRoot = getRepoRoot(wsRoot);
    const branches = getLocalBranchesSorted(repoRoot, 100);

    if (branches.length === 0) {
      vscode.window.showInformationMessage('No Git branches found.');
      return;
    }

    const selected = await vscode.window.showQuickPick(branches, {
      placeHolder: 'Select a branch to checkout (git checkout)',
    });

    if (selected) {
      try {
        switchBranch(repoRoot, selected);
        vscode.window.showInformationMessage(`Switched to branch: ${selected}`);
        treeDataProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to switch branch: ${err.message}`);
      }
    }
  });

  // 4. Helper function to show structural diff in Webview (reusing existing panel)
  let currentPanel: vscode.WebviewPanel | undefined;
  let activeChangeSub: vscode.Disposable | undefined;
  let lastRenderedKey: string | undefined;

  function showDiffPanel(
    filePath: string,
    title: string,
    getVersionsFn: () => { oldContent: string; newContent: string; repoRelativePath: string },
    cacheKey?: string
  ) {
    try {
      if (isBinaryFile(filePath)) {
        if (currentPanel) {
          currentPanel.title = title;
          currentPanel.webview.html = renderBinaryNoticeHtml(filePath);
          if (!currentPanel.visible) {
            currentPanel.reveal(currentPanel.viewColumn || vscode.ViewColumn.Beside, true);
          }
        } else {
          currentPanel = vscode.window.createWebviewPanel(
            'structuralDiff',
            title,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true }
          );
          currentPanel.webview.html = renderBinaryNoticeHtml(filePath);
          currentPanel.onDidDispose(() => {
            if (activeChangeSub) {
              activeChangeSub.dispose();
              activeChangeSub = undefined;
            }
            currentPanel = undefined;
            lastRenderedKey = undefined;
          });
        }
        return;
      }

      const versions = getVersionsFn();
      const contentKey =
        cacheKey ??
        `${filePath}:${versions.oldContent.length}:${versions.newContent.length}:${versions.oldContent.slice(0, 40)}:${versions.newContent.slice(0, 40)}`;

      if (currentPanel && lastRenderedKey === contentKey) {
        currentPanel.title = title;
        if (!currentPanel.visible) {
          currentPanel.reveal(currentPanel.viewColumn || vscode.ViewColumn.Beside, true);
        }
        return;
      }

      const lines = computeLineDiff(versions.oldContent, versions.newContent);
      const structuralDiff = buildStructuralDiff(
        versions.repoRelativePath,
        versions.oldContent,
        versions.newContent,
        lines
      );

      lastRenderedKey = contentKey;

      // Clean up previous save watcher
      if (activeChangeSub) {
        activeChangeSub.dispose();
        activeChangeSub = undefined;
      }

      if (currentPanel) {
        // In-place DOM update via postMessage avoids iframe rebuild and never steals tree keyboard focus!
        currentPanel.title = title;
        const parts = renderDiffParts(structuralDiff);
        currentPanel.webview.postMessage({
          type: 'updateDiff',
          summaryRowsHtml: parts.summaryRowsHtml,
          rowsHtml: parts.rowsHtml,
          title,
        });
        if (!currentPanel.visible) {
          currentPanel.reveal(currentPanel.viewColumn || vscode.ViewColumn.Beside, true);
        }
      } else {
        // Create panel once with preserveFocus so keyboard navigation is never interrupted
        currentPanel = vscode.window.createWebviewPanel(
          'structuralDiff',
          title,
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
          {
            enableScripts: true,
            retainContextWhenHidden: true,
          }
        );

        currentPanel.webview.html = renderDiffHtml(structuralDiff);

        currentPanel.onDidDispose(() => {
          if (activeChangeSub) {
            activeChangeSub.dispose();
            activeChangeSub = undefined;
          }
          currentPanel = undefined;
          lastRenderedKey = undefined;
        });
      }

      // Auto-refresh when document is saved
      activeChangeSub = vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.fsPath === filePath && currentPanel) {
          const refreshedVersions = getVersionsFn();
          const refreshedLines = computeLineDiff(refreshedVersions.oldContent, refreshedVersions.newContent);
          const refreshedDiff = buildStructuralDiff(
            refreshedVersions.repoRelativePath,
            refreshedVersions.oldContent,
            refreshedVersions.newContent,
            refreshedLines
          );
          lastRenderedKey = `${filePath}:${refreshedVersions.oldContent.length}:${refreshedVersions.newContent.length}:${refreshedVersions.oldContent.slice(0, 40)}:${refreshedVersions.newContent.slice(0, 40)}`;
          const parts = renderDiffParts(refreshedDiff);
          currentPanel.webview.postMessage({
            type: 'updateDiff',
            summaryRowsHtml: parts.summaryRowsHtml,
            rowsHtml: parts.rowsHtml,
            title,
          });
          treeDataProvider.refresh();
        }
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to build structural diff: ${err.message}`);
    }
  }

  // 5. Helper for opening file in editor (for double-click / edit command)
  async function openFileForEditing(filePath: string) {
    if (!fs.existsSync(filePath)) {
      vscode.window.showInformationMessage(`File not found on disk: ${path.basename(filePath)}`);
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      const activeCol = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: activeCol });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to open file for editing: ${err.message}`);
    }
  }

  // 5.1 Double-click detection tracker
  let lastClick = { path: '', timestamp: 0 };
  const DOUBLE_CLICK_THRESHOLD_MS = 400;

  async function checkDoubleClickAndOpenForEditing(filePath: string): Promise<boolean> {
    const now = Date.now();
    if (lastClick.path === filePath && now - lastClick.timestamp < DOUBLE_CLICK_THRESHOLD_MS) {
      lastClick = { path: '', timestamp: 0 };
      await openFileForEditing(filePath);
      return true;
    }
    lastClick = { path: filePath, timestamp: now };
    return false;
  }

  // 5.5 Command: Edit file directly
  registerCommand('editFile', async (arg: any) => {
    let filePath: string | undefined;
    if (arg instanceof vscode.Uri) {
      filePath = arg.fsPath;
    } else if (arg?.file?.filePath) {
      filePath = arg.file.filePath;
    } else if (arg?.filePath) {
      filePath = arg.filePath;
    }
    if (filePath) {
      await openFileForEditing(filePath);
    }
  });

  // 6. Command: Open diff for working tree vs HEAD
  registerCommand('openDiff', async (arg?: any, fromSelection?: boolean) => {
    let targetUri: vscode.Uri | undefined;

    if (arg instanceof vscode.Uri) {
      targetUri = arg;
    } else if (arg && typeof arg === 'object') {
      if (arg.resourceUri instanceof vscode.Uri) {
        targetUri = arg.resourceUri;
      } else if (arg.uri instanceof vscode.Uri) {
        targetUri = arg.uri;
      }
    }

    if (!targetUri) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        targetUri = editor.document.uri;
      }
    }

    if (!targetUri || !targetUri.fsPath) {
      vscode.window.showInformationMessage('Select or open a file to view diff.');
      return;
    }

    const filePath = targetUri.fsPath;

    if (!fromSelection) {
      const isDbl = await checkDoubleClickAndOpenForEditing(filePath);
      if (isDbl) return;
    }

    const fileName = path.basename(filePath);
    showDiffPanel(filePath, `Diff: ${fileName}`, () => {
      const versions = getFileVersions(filePath);
      // Use live editor buffer if available
      const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === filePath);
      if (openDoc) {
        versions.newContent = openDoc.getText();
      }
      return versions;
    });
  });

  // 7. Command: Open diff for a specific commit (commit vs commit~1)
  registerCommand('openCommitDiff', async (arg: any, commitHash?: string, fromSelection?: boolean) => {
    let targetUri: vscode.Uri | undefined;
    if (arg instanceof vscode.Uri) {
      targetUri = arg;
    } else if (arg && typeof arg === 'object' && arg.resourceUri instanceof vscode.Uri) {
      targetUri = arg.resourceUri;
    }

    if (!targetUri || !commitHash) {
      vscode.window.showInformationMessage('Select a commit file to view diff.');
      return;
    }
    const filePath = targetUri.fsPath;

    if (!fromSelection) {
      const isDbl = await checkDoubleClickAndOpenForEditing(filePath);
      if (isDbl) return;
    }

    const fileName = path.basename(filePath);
    showDiffPanel(
      filePath,
      `${commitHash.slice(0, 7)} - ${fileName}`,
      () => {
        return getCommitVersions(filePath, commitHash);
      },
      `${commitHash}:${filePath}`
    );
  });

  // 8. Auto-refresh sidebar on file saves with debounce
  let saveDebounceTimer: NodeJS.Timeout | undefined;
  const saveWatcher = vscode.workspace.onDidSaveTextDocument(() => {
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer);
    }
    saveDebounceTimer = setTimeout(() => {
      treeDataProvider.refresh();
    }, 500);
  });
  context.subscriptions.push(saveWatcher);

  // 9. Cleanup pending timers and resources on deactivation
  context.subscriptions.push({
    dispose: () => {
      if (selectionDebounceTimer) clearTimeout(selectionDebounceTimer);
      if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
      if (activeChangeSub) activeChangeSub.dispose();
    },
  });
}

export function deactivate() {}
