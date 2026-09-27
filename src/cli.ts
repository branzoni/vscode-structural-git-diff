import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeLineDiff } from './diff/diffEngine';
import { buildStructuralDiff } from './diff/structuralBuilder';
import { getCommitVersions, getFileVersions } from './git/gitService';
import { renderDiffHtml } from './ui/diffHtmlRenderer';

function parseArgs(): { file?: string; commit?: string; html?: string } {
  const args = process.argv.slice(2);
  const result: { file?: string; commit?: string; html?: string } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      result.file = args[++i];
    } else if (args[i] === '--commit' && args[i + 1]) {
      result.commit = args[++i];
    } else if (args[i] === '--html' && args[i + 1]) {
      result.html = args[++i];
    }
  }

  return result;
}

function run() {
  const { file, commit, html } = parseArgs();

  if (!file) {
    console.error('Usage: node dist/cli.js --file <path-to-file> [--commit <commit>] [--html <output.html>]');
    process.exit(1);
  }

  const fullPath = path.resolve(process.cwd(), file);
  const versions = commit ? getCommitVersions(fullPath, commit) : getFileVersions(fullPath);

  const lines = computeLineDiff(versions.oldContent, versions.newContent);
  const diff = buildStructuralDiff(versions.repoRelativePath, versions.oldContent, versions.newContent, lines);

  // If HTML output requested, save to file
  if (html) {
    const htmlContent = renderDiffHtml(diff);
    fs.writeFileSync(html, htmlContent, 'utf8');
    console.log(`HTML diff saved to: ${html}`);
    return;
  }

  // Print ANSI colored terminal output
  console.log(
    `\n\x1b[1m\x1b[36m--- Structural Git Diff: ${diff.filePath} (+${diff.stats.added} -${diff.stats.deleted}) ---\x1b[0m\n`
  );

  for (const item of diff.items) {
    if (item.kind === 'line') {
      const l = item.line;
      const oldNum = (l.oldLineNumber !== null ? l.oldLineNumber.toString() : '').padStart(5, ' ');
      const newNum = (l.newLineNumber !== null ? l.newLineNumber.toString() : '').padStart(5, ' ');

      if (l.type === 'insert') {
        console.log(`\x1b[32m+ ${oldNum} ${newNum} | + ${l.content}\x1b[0m`);
      } else if (l.type === 'delete') {
        console.log(`\x1b[31m- ${oldNum} ${newNum} | - ${l.content}\x1b[0m`);
      } else {
        // Dimmed dark gray for unchanged lines
        console.log(`\x1b[90m  ${oldNum} ${newNum} |   ${l.content}\x1b[0m`);
      }
    } else if (item.kind === 'expand') {
      console.log(`\x1b[34m\x1b[1m${item.label}\x1b[0m`);
    }
  }
  console.log('');
}

run();
