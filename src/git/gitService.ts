import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function git(args: string[], options: { cwd: string; maxBuffer?: number }): string {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: options.maxBuffer,
  });
}

export interface GitFileVersions {
  filePath: string;
  repoRelativePath: string;
  oldContent: string;
  newContent: string;
  repoRoot: string;
}

export interface WorkingFileChange {
  filePath: string;
  repoRelativePath: string;
  fileName: string;
  status: string;
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface CommitFile {
  filePath: string;
  repoRelativePath: string;
  fileName: string;
  status?: string;
}

export function getRepoRoot(filePath: string): string {
  try {
    let dir = filePath;
    while (dir && !fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const checkDir = fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : path.dirname(dir);
    return git(['rev-parse', '--show-toplevel'], { cwd: checkDir }).trim();
  } catch {
    return path.dirname(filePath);
  }
}

export function getCurrentBranch(repoRoot: string): string {
  try {
    const branch = git(['branch', '--show-current'], { cwd: repoRoot }).trim();
    if (branch) return branch;
    const rev = git(['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).trim();
    return `detached (${rev})`;
  } catch {
    return 'unknown';
  }
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  upstream?: string;
  trackStatus?: string;
}

export function getLocalBranchesSorted(repoRoot: string, limit = 50): string[] {
  try {
    const output = git(
      ['for-each-ref', '--sort=-committerdate', `--count=${limit}`, 'refs/heads/', '--format=%(refname:short)'],
      { cwd: repoRoot }
    );
    return output
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function getLocalBranchesWithStatus(repoRoot: string, limit = 50): BranchInfo[] {
  try {
    const current = getCurrentBranch(repoRoot);
    const output = git(
      [
        'for-each-ref',
        '--sort=-committerdate',
        `--count=${limit}`,
        '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)',
        'refs/heads/',
      ],
      { cwd: repoRoot }
    );
    const branches: BranchInfo[] = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const [name, upstream, track] = line.split('\t');
      let trackStatus: string | undefined;
      if (!upstream) {
        trackStatus = 'local';
      } else if (track === 'gone') {
        trackStatus = 'gone';
      } else if (track) {
        trackStatus = track
          .replace(/ahead\s+(\d+)/, '↑$1')
          .replace(/behind\s+(\d+)/, '↓$1')
          .replace(/,\s*/, ' ');
      }
      branches.push({
        name,
        isCurrent: name === current,
        upstream: upstream || undefined,
        trackStatus,
      });
      if (branches.length >= limit) break;
    }
    return branches;
  } catch {
    return [];
  }
}

export function getRemoteBranchesSorted(repoRoot: string, limit = 50): string[] {
  try {
    const output = git(
      ['for-each-ref', '--sort=-committerdate', `--count=${limit}`, 'refs/remotes/', '--format=%(refname:short)'],
      { cwd: repoRoot }
    );
    return output
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b && !b.endsWith('/HEAD') && b !== 'origin')
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function getRemoteOnlyBranchesSorted(repoRoot: string, localBranches?: BranchInfo[], limit = 50): string[] {
  try {
    const localNames = new Set<string>();
    const localUpstreams = new Set<string>();

    if (localBranches && localBranches.length > 0) {
      for (const b of localBranches) {
        if (b.name) localNames.add(b.name);
        if (b.upstream) localUpstreams.add(b.upstream);
      }
    } else {
      const localOutput = git(['for-each-ref', '--format=%(refname:short)%09%(upstream:short)', 'refs/heads/'], {
        cwd: repoRoot,
      });
      for (const line of localOutput.split('\n')) {
        if (!line.trim()) continue;
        const [name, upstream] = line.split('\t');
        if (name) localNames.add(name);
        if (upstream) localUpstreams.add(upstream);
      }
    }

    const output = git(
      ['for-each-ref', '--sort=-committerdate', '--count=100', 'refs/remotes/', '--format=%(refname:short)'],
      { cwd: repoRoot }
    );
    const results: string[] = [];
    for (const raw of output.split('\n')) {
      const b = raw.trim();
      if (!b || b.endsWith('/HEAD') || b === 'origin') continue;
      // Skip if already tracked by a local branch
      if (localUpstreams.has(b)) continue;
      // Skip if short name matches local branch (e.g. origin/foo matches local foo)
      const shortName = b.includes('/') ? b.split('/').slice(1).join('/') : b;
      if (localNames.has(shortName)) continue;

      results.push(b);
      if (results.length >= limit) break;
    }
    return results;
  } catch {
    return [];
  }
}

export function getCommitsForBranch(repoRoot: string, branchName: string, maxCount = 25): CommitInfo[] {
  try {
    const output = git(['log', branchName, '-n', String(maxCount), '--pretty=format:%h%x09%an%x09%ar%x09%s'], {
      cwd: repoRoot,
    });
    const lines = output.split('\n').filter(Boolean);
    return lines.map((l) => {
      const [hash, author, date, ...msgParts] = l.split('\t');
      return {
        hash,
        author,
        date,
        message: msgParts.join('\t'),
      };
    });
  } catch {
    return [];
  }
}

export function switchBranch(repoRoot: string, branchName: string): void {
  git(['checkout', branchName], { cwd: repoRoot });
}

export const SUPPORTED_CODE_EXTS = ['.php', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];

export function isSupportedCodeFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SUPPORTED_CODE_EXTS.some((ext) => lower.endsWith(ext));
}

const BINARY_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.7z',
  '.rar',
  '.bz2',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.flac',
  '.wav',
  '.lockb',
  '.pyc',
  '.class',
  '.jar',
  '.wasm',
]);

export function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTS.has(ext);
}

export function commitWorkingChanges(repoRoot: string, message: string): void {
  git(['add', '-A'], { cwd: repoRoot });
  git(['commit', '-m', message], { cwd: repoRoot });
}

export function getWorkingCodeChanges(repoRoot: string): WorkingFileChange[] {
  try {
    const output = git(['status', '--porcelain', '-uall'], { cwd: repoRoot });
    const lines = output.split('\n').filter(Boolean);
    const results: WorkingFileChange[] = [];

    for (const line of lines) {
      const status = line.slice(0, 2).trim();
      const rawPath = line.slice(3).trim();
      // Handle renamed files "old -> new"
      let targetPath = rawPath.includes(' -> ') ? rawPath.split(' -> ')[1] : rawPath;
      if (targetPath.startsWith('"') && targetPath.endsWith('"')) {
        targetPath = targetPath.slice(1, -1);
      }

      if (targetPath) {
        const fullPath = path.resolve(repoRoot, targetPath);
        results.push({
          filePath: fullPath,
          repoRelativePath: targetPath,
          fileName: path.basename(targetPath),
          status,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

export const getWorkingPhpChanges = getWorkingCodeChanges;

export function getRecentCommits(repoRoot: string, maxCount = 20): CommitInfo[] {
  try {
    const output = git(['log', '-n', String(maxCount), '--pretty=format:%h%x09%an%x09%ar%x09%s'], { cwd: repoRoot });
    const lines = output.split('\n').filter(Boolean);
    return lines.map((l) => {
      const [hash, author, date, ...msgParts] = l.split('\t');
      return {
        hash,
        author,
        date,
        message: msgParts.join('\t'),
      };
    });
  } catch {
    return [];
  }
}

export function getCommitCodeFiles(repoRoot: string, commit: string): CommitFile[] {
  try {
    const output = git(['show', '--name-status', '-m', '--format=', commit], {
      cwd: repoRoot,
      maxBuffer: 50 * 1024 * 1024,
    });
    const unique = new Set<string>();
    const results: CommitFile[] = [];

    for (const raw of output.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split('\t');
      const status = parts[0].trim();
      let rawPath = parts[parts.length - 1].trim();
      if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
        rawPath = rawPath.slice(1, -1);
      }
      if (rawPath && !unique.has(rawPath)) {
        unique.add(rawPath);
        results.push({
          filePath: path.resolve(repoRoot, rawPath),
          repoRelativePath: rawPath,
          fileName: path.basename(rawPath),
          status,
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

export const getCommitPhpFiles = getCommitCodeFiles;

export function getFileVersions(filePath: string, commit = 'HEAD'): GitFileVersions {
  const repoRoot = getRepoRoot(filePath);
  const repoRelativePath = path.relative(repoRoot, filePath);

  let oldContent = '';
  try {
    oldContent = git(['show', `${commit}:${repoRelativePath}`], {
      cwd: repoRoot,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    oldContent = '';
  }

  let newContent = '';
  if (fs.existsSync(filePath)) {
    newContent = fs.readFileSync(filePath, 'utf8');
  }

  return {
    filePath,
    repoRelativePath,
    oldContent,
    newContent,
    repoRoot,
  };
}

export function getCommitVersions(filePath: string, commit: string): GitFileVersions {
  const repoRoot = getRepoRoot(filePath);
  const repoRelativePath = path.relative(repoRoot, filePath);

  let oldContent = '';
  try {
    oldContent = git(['show', `${commit}^1:${repoRelativePath}`], {
      cwd: repoRoot,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    oldContent = '';
  }

  let newContent = '';
  try {
    newContent = git(['show', `${commit}:${repoRelativePath}`], {
      cwd: repoRoot,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    newContent = '';
  }

  return {
    filePath,
    repoRelativePath,
    oldContent,
    newContent,
    repoRoot,
  };
}

export function getGitFileContent(repoRoot: string, ref: string, relPath: string): string {
  try {
    return git(['show', `${ref}:${relPath}`], {
      cwd: repoRoot,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}
