import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  type BranchInfo,
  type CommitFile,
  type CommitInfo,
  getCommitPhpFiles,
  getCommitsForBranch,
  getLocalBranchesWithStatus,
  getRemoteOnlyBranchesSorted,
  getRepoRoot,
  getWorkingPhpChanges,
  type WorkingFileChange,
} from '../git/gitService';

export type TreeNode =
  | CategoryNode
  | BranchNode
  | WorkingFileNode
  | CommitNode
  | CommitFileNode
  | EmptyInfoNode
  | LoadMoreCommitsNode
  | CommitWorkingChangesNode;

export class CommitWorkingChangesNode {
  readonly kind = 'commitWorkingChanges';
  constructor(public parent?: TreeNode) {}
}

export class LoadMoreCommitsNode {
  readonly kind = 'loadMoreCommits';
  constructor(
    public readonly branchName: string,
    public readonly currentCount: number,
    public parent?: TreeNode
  ) {}
}

export class CategoryNode {
  readonly kind = 'category';
  constructor(
    public readonly categoryId: 'working' | 'localBranches' | 'remoteBranches',
    public readonly label: string,
    public readonly count?: number,
    public parent?: TreeNode
  ) {}
}

export class BranchNode {
  readonly kind = 'branch';
  constructor(
    public readonly branchName: string,
    public readonly isCurrent: boolean,
    public readonly isRemote: boolean,
    public readonly trackStatus?: string,
    public readonly upstream?: string,
    public parent?: TreeNode
  ) {}
}

export class WorkingFileNode {
  readonly kind = 'workingFile';
  constructor(
    public readonly file: WorkingFileChange,
    public parent?: TreeNode
  ) {}
}

export class CommitNode {
  readonly kind = 'commit';
  constructor(
    public readonly commit: CommitInfo,
    public readonly branchName: string,
    public parent?: TreeNode
  ) {}
}

export class CommitFileNode {
  readonly kind = 'commitFile';
  constructor(
    public readonly file: CommitFile,
    public readonly commitHash: string,
    public parent?: TreeNode
  ) {}
}

export class EmptyInfoNode {
  readonly kind = 'emptyInfo';
  constructor(
    public readonly text: string,
    public parent?: TreeNode
  ) {}
}

export class GitTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | void> = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | void> = this._onDidChangeTreeData.event;

  private readonly commitFilesCache = new Map<string, CommitFile[]>();
  private readonly branchCommitsCache = new Map<string, CommitInfo[]>();
  private readonly branchCommitLimits = new Map<string, number>();
  private cachedWorkingFiles: WorkingFileChange[] | null = null;
  private cachedLocalBranches: BranchInfo[] | null = null;
  private cachedRemoteBranches: string[] | null = null;

  constructor(private readonly getWorkspaceRoot: () => string | undefined) {}

  refresh(): void {
    this.cachedWorkingFiles = null;
    this.cachedLocalBranches = null;
    this.cachedRemoteBranches = null;
    this.commitFilesCache.clear();
    this.branchCommitsCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  loadMoreCommits(branchName: string): void {
    const current = this.branchCommitLimits.get(branchName) || 30;
    this.branchCommitLimits.set(branchName, current + 30);
    this.branchCommitsCache.delete(branchName);
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'category': {
        const title = element.count !== undefined ? `${element.label} (${element.count})` : element.label;
        // Working changes & local branches expanded by default; remote branches collapsed
        const collapsibleState =
          element.categoryId === 'remoteBranches'
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded;

        const item = new vscode.TreeItem(title, collapsibleState);
        if (element.categoryId === 'working') {
          item.iconPath = new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('charts.yellow'));
        } else if (element.categoryId === 'localBranches') {
          item.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor('charts.blue'));
        } else {
          item.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('charts.purple'));
        }
        item.contextValue = element.categoryId === 'working' ? 'categoryWorking' : 'category';
        return item;
      }

      case 'branch': {
        const title = element.isCurrent ? `${element.branchName} ● current` : element.branchName;
        const collapsibleState = element.isCurrent
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;

        const item = new vscode.TreeItem(title, collapsibleState);
        if (element.trackStatus) {
          item.description = element.trackStatus;
        }

        if (element.isCurrent) {
          item.iconPath = new vscode.ThemeIcon(
            'pass-filled',
            new vscode.ThemeColor('gitDecoration.addedResourceForeground')
          );
        } else if (element.isRemote) {
          item.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('charts.purple'));
        } else {
          item.iconPath = new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('charts.blue'));
        }

        let tooltip = element.isCurrent
          ? `Current active branch: ${element.branchName}`
          : element.isRemote
            ? `Remote branch: ${element.branchName}`
            : `Local branch: ${element.branchName}`;

        if (element.trackStatus) {
          if (element.trackStatus.includes('↑') && element.trackStatus.includes('↓')) {
            tooltip += `\nSync: diverged from ${element.upstream} (${element.trackStatus})`;
          } else if (element.trackStatus.includes('↑')) {
            tooltip += `\nSync: ahead of ${element.upstream} (${element.trackStatus}) — push needed`;
          } else if (element.trackStatus.includes('↓')) {
            tooltip += `\nSync: behind ${element.upstream} (${element.trackStatus}) — pull needed`;
          } else if (element.trackStatus === 'gone') {
            tooltip += `\nSync: remote branch (${element.upstream}) was deleted`;
          } else if (element.trackStatus === 'local') {
            tooltip += `\nSync: local branch (not pushed to remote)`;
          }
        } else if (element.upstream) {
          tooltip += `\nSync: in sync with ${element.upstream}`;
        }

        if (!element.isRemote && !element.isCurrent) {
          tooltip += `\n(right-click to checkout)`;
        }

        item.tooltip = tooltip;
        item.contextValue = element.isCurrent ? 'currentBranch' : element.isRemote ? 'remoteBranch' : 'localBranch';
        return item;
      }

      case 'workingFile': {
        const f = element.file;
        const item = new vscode.TreeItem(f.fileName, vscode.TreeItemCollapsibleState.None);
        const dir = path.dirname(f.repoRelativePath);
        item.description = dir && dir !== '.' ? dir : '';
        item.tooltip = `[${f.status}] ${f.repoRelativePath}`;

        const status = f.status.toUpperCase();
        if (status.includes('M')) {
          item.iconPath = new vscode.ThemeIcon(
            'diff-modified',
            new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
          );
        } else if (status.includes('A') || status.includes('?')) {
          item.iconPath = new vscode.ThemeIcon(
            'diff-added',
            new vscode.ThemeColor('gitDecoration.addedResourceForeground')
          );
        } else if (status.includes('D')) {
          item.iconPath = new vscode.ThemeIcon(
            'diff-removed',
            new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
          );
        } else {
          item.iconPath = new vscode.ThemeIcon('file-code', new vscode.ThemeColor('charts.blue'));
        }

        item.command = {
          command: 'structuralDiff.openDiff',
          title: 'Open Structural Diff',
          arguments: [vscode.Uri.file(f.filePath)],
        };
        item.contextValue = 'workingFile';
        return item;
      }

      case 'commit': {
        const c = element.commit;
        const shortHash = c.hash ? c.hash.slice(0, 7) : '';
        const label = c.message || shortHash;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        const descParts: string[] = [];
        if (shortHash) descParts.push(shortHash);
        if (c.author) descParts.push(c.author);
        if (c.date) descParts.push(c.date);
        item.description = descParts.join(' • ');
        item.tooltip = `${c.message}\nCommit: ${c.hash}\nAuthor: ${c.author}\nDate: ${c.date}\nBranch: ${element.branchName}`;
        item.iconPath = new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('charts.orange'));
        item.contextValue = 'commit';
        return item;
      }

      case 'commitFile': {
        const cf = element.file;
        const item = new vscode.TreeItem(cf.fileName, vscode.TreeItemCollapsibleState.None);
        const dir = path.dirname(cf.repoRelativePath);
        item.description = dir && dir !== '.' ? dir : '';
        const statusPrefix = cf.status ? `[${cf.status}] ` : '';
        item.tooltip = `${statusPrefix}${cf.repoRelativePath} (${element.commitHash})`;

        const status = (cf.status || '').toUpperCase();
        if (status.includes('M')) {
          item.iconPath = new vscode.ThemeIcon(
            'diff-modified',
            new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
          );
        } else if (status.includes('A')) {
          item.iconPath = new vscode.ThemeIcon(
            'diff-added',
            new vscode.ThemeColor('gitDecoration.addedResourceForeground')
          );
        } else if (status.includes('D')) {
          item.iconPath = new vscode.ThemeIcon(
            'diff-removed',
            new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
          );
        } else {
          item.iconPath = new vscode.ThemeIcon('file', new vscode.ThemeColor('charts.blue'));
        }

        item.command = {
          command: 'structuralDiff.openCommitDiff',
          title: 'Open Commit Diff',
          arguments: [vscode.Uri.file(cf.filePath), element.commitHash],
        };
        item.contextValue = 'commitFile';
        return item;
      }

      case 'emptyInfo': {
        const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }

      case 'loadMoreCommits': {
        const item = new vscode.TreeItem('Load 30 more commits...', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('chevron-down');
        item.command = {
          command: 'structuralDiff.loadMoreCommits',
          title: 'Load More Commits',
          arguments: [element.branchName],
        };
        item.contextValue = 'loadMoreCommits';
        return item;
      }

      case 'commitWorkingChanges': {
        const item = new vscode.TreeItem('Commit all changes...', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
        item.command = {
          command: 'structuralDiff.commitChanges',
          title: 'Commit Working Changes',
        };
        item.contextValue = 'commitWorkingChanges';
        return item;
      }
    }
  }

  getChildren(element?: TreeNode): vscode.ProviderResult<TreeNode[]> {
    const wsRoot = this.getWorkspaceRoot();
    if (!wsRoot) return [];

    const repoRoot = getRepoRoot(wsRoot);

    if (!element) {
      // Root level categories:
      // 1. Working Changes
      // 2. Local Branches
      // 3. Remote Branches (remote-only, excluding local duplicates)
      this.cachedWorkingFiles = getWorkingPhpChanges(repoRoot);
      this.cachedLocalBranches = getLocalBranchesWithStatus(repoRoot, 50);
      this.cachedRemoteBranches = getRemoteOnlyBranchesSorted(repoRoot, this.cachedLocalBranches, 50);

      return [
        new CategoryNode('working', 'Working Changes', this.cachedWorkingFiles.length),
        new CategoryNode('localBranches', 'Local Branches', this.cachedLocalBranches.length),
        new CategoryNode('remoteBranches', 'Remote Branches', this.cachedRemoteBranches.length),
      ];
    }

    if (element.kind === 'category') {
      if (element.categoryId === 'working') {
        const workingFiles = this.cachedWorkingFiles ?? getWorkingPhpChanges(repoRoot);
        this.cachedWorkingFiles = workingFiles;
        if (workingFiles.length === 0) {
          return [new EmptyInfoNode('(no uncommitted changes)', element)];
        }
        const sorted = [...workingFiles].sort((a, b) =>
          a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' })
        );
        return [new CommitWorkingChangesNode(element), ...sorted.map((wf) => new WorkingFileNode(wf, element))];
      }

      if (element.categoryId === 'localBranches') {
        const locals = this.cachedLocalBranches ?? getLocalBranchesWithStatus(repoRoot, 50);
        this.cachedLocalBranches = locals;

        // Put current branch at the very top
        const sorted = [...locals.filter((b) => b.isCurrent), ...locals.filter((b) => !b.isCurrent)];

        return sorted.map((b) => new BranchNode(b.name, b.isCurrent, false, b.trackStatus, b.upstream, element));
      }

      if (element.categoryId === 'remoteBranches') {
        const remotes =
          this.cachedRemoteBranches ?? getRemoteOnlyBranchesSorted(repoRoot, this.cachedLocalBranches ?? undefined, 50);
        this.cachedRemoteBranches = remotes;
        if (remotes.length === 0) {
          return [new EmptyInfoNode('(all remote branches already exist locally)', element)];
        }
        return remotes.map((b) => new BranchNode(b, false, true, undefined, undefined, element));
      }
    }

    if (element.kind === 'branch') {
      // Lazy load commits for this branch with dynamic limit
      const branchName = element.branchName;
      const limit = this.branchCommitLimits.get(branchName) || 30;
      let commits = this.branchCommitsCache.get(branchName);
      if (!commits) {
        commits = getCommitsForBranch(repoRoot, branchName, limit + 1);
        this.branchCommitsCache.set(branchName, commits);
      }

      if (commits.length === 0) {
        return [new EmptyInfoNode('(no commits found)', element)];
      }

      const hasMore = commits.length > limit;
      const displayCommits = hasMore ? commits.slice(0, limit) : commits;
      const nodes: TreeNode[] = displayCommits.map((c) => new CommitNode(c, branchName, element));

      if (hasMore) {
        nodes.push(new LoadMoreCommitsNode(branchName, limit, element));
      }

      return nodes;
    }

    if (element.kind === 'commit') {
      // Lazy load PHP files for this commit
      const commitHash = element.commit.hash;
      let files = this.commitFilesCache.get(commitHash);
      if (!files) {
        files = getCommitPhpFiles(repoRoot, commitHash);
        this.commitFilesCache.set(commitHash, files);
      }

      if (files.length === 0) {
        return [new EmptyInfoNode('(no files in this commit)', element)];
      }

      const sorted = [...files].sort((a, b) =>
        a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' })
      );

      return sorted.map((cf) => new CommitFileNode(cf, commitHash, element));
    }

    return [];
  }

  getParent(element: TreeNode): vscode.ProviderResult<TreeNode> {
    return element.parent;
  }
}
