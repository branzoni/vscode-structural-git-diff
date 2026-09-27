import * as assert from 'node:assert';
import { computeLineDiff } from '../diff/diffEngine';
import { buildStructuralDiff } from '../diff/structuralBuilder';
import { getGitFileContent, isBinaryFile, isSupportedCodeFile } from '../git/gitService';
import { parsePhpStructure } from '../parser/phpSymbols';
import { parseStructureForFile } from '../parser/symbolParser';
import { parseTsStructure } from '../parser/tsSymbols';
import { renderBinaryNoticeHtml, renderDiffHtml, renderDiffParts } from '../ui/diffHtmlRenderer';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}`);
    console.error(`    ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
    failed++;
  }
}

console.log('\n\x1b[1m=== Running Structural Git Diff Test Suite ===\x1b[0m\n');

// ---------------------------------------------------------------------------
// 1. Git Service: isSupportedCodeFile
// ---------------------------------------------------------------------------
console.log('\x1b[36m[Group 1: Supported Code Files]\x1b[0m');

test('identifies PHP files as supported', () => {
  assert.strictEqual(isSupportedCodeFile('/path/to/File.php'), true);
  assert.strictEqual(isSupportedCodeFile('index.PHP'), true);
});

test('identifies JS/TS files as supported', () => {
  assert.strictEqual(isSupportedCodeFile('/path/to/app.ts'), true);
  assert.strictEqual(isSupportedCodeFile('/path/to/Component.tsx'), true);
  assert.strictEqual(isSupportedCodeFile('/path/to/bundle.js'), true);
  assert.strictEqual(isSupportedCodeFile('/path/to/View.jsx'), true);
  assert.strictEqual(isSupportedCodeFile('/path/to/script.mjs'), true);
  assert.strictEqual(isSupportedCodeFile('/path/to/config.cjs'), true);
});

test('rejects non-code files', () => {
  assert.strictEqual(isSupportedCodeFile('/path/to/readme.md'), false);
  assert.strictEqual(isSupportedCodeFile('/path/to/styles.css'), false);
  assert.strictEqual(isSupportedCodeFile('/path/to/data.json'), false);
  assert.strictEqual(isSupportedCodeFile('/path/to/icon.svg'), false);
});

test('identifies binary files vs text files', () => {
  assert.strictEqual(isBinaryFile('image.png'), true);
  assert.strictEqual(isBinaryFile('doc.pdf'), true);
  assert.strictEqual(isBinaryFile('archive.zip'), true);
  assert.strictEqual(isBinaryFile('app.exe'), true);
  assert.strictEqual(isBinaryFile('lib.so'), true);
  assert.strictEqual(isBinaryFile('index.php'), false);
  assert.strictEqual(isBinaryFile('app.ts'), false);
  assert.strictEqual(isBinaryFile('README.md'), false);
  assert.strictEqual(isBinaryFile('package.json'), false);
  assert.strictEqual(isBinaryFile('styles.css'), false);
});

test('getGitFileContent returns content or empty string gracefully', () => {
  const nonExistent = getGitFileContent('/tmp', 'HEAD', 'non_existent_xyz.txt');
  assert.strictEqual(nonExistent, '');
});

// ---------------------------------------------------------------------------
// 2. Parser: PHP Symbols
// ---------------------------------------------------------------------------
console.log('\n\x1b[36m[Group 2: PHP AST Parser]\x1b[0m');

test('parses PHP class, namespace, uses, methods and properties', () => {
  const phpCode = `<?php
namespace App\\Services;

use App\\Models\\User;
use App\\Contracts\\Authenticatable;

class UserService
{
    private User $user;
    public const DEFAULT_ROLE = 'user';

    public function __construct(User $user)
    {
        $this->user = $user;
    }

    public function getUserName(): string
    {
        return $this->user->getName();
    }
}
`;

  const structure = parsePhpStructure(phpCode);

  assert.strictEqual(structure.namespace?.name, 'App\\Services');
  assert.strictEqual(structure.uses.length, 2);
  assert.strictEqual(structure.uses[0].name, 'App\\Models\\User');
  assert.strictEqual(structure.uses[1].name, 'App\\Contracts\\Authenticatable');

  assert.strictEqual(structure.containers.length, 1);
  const cls = structure.containers[0];
  assert.strictEqual(cls.name, 'UserService');
  assert.strictEqual(cls.kind, 'class');

  assert.strictEqual(structure.methods.length, 2);
  assert.strictEqual(structure.methods[0].name, '__construct');
  assert.strictEqual(structure.methods[1].name, 'getUserName');

  assert.strictEqual(structure.properties.length, 1);
  assert.strictEqual(structure.properties[0].name, 'user');

  assert.strictEqual(structure.constants.length, 1);
  assert.strictEqual(structure.constants[0].name, 'DEFAULT_ROLE');
});

test('parses modern PHP 8.4 syntax via token/regex fallback without crashing', () => {
  const modernPhpCode = `<?php
namespace App\\Modern;

use Foo\\Bar;

class ModernRunner
{
    public function execute(): void
    {
        // PHP 8.4 new without parentheses or direct call
        $result = new Action()();
        $val = new Handler()->process();
    }

    public function calculate(int|string $input): mixed
    {
        return $input;
    }
}
`;

  const structure = parsePhpStructure(modernPhpCode);
  assert.strictEqual(structure.namespace?.name, 'App\\Modern');
  assert.strictEqual(structure.uses.length, 1);
  assert.strictEqual(structure.containers.length, 1);
  assert.strictEqual(structure.containers[0].name, 'ModernRunner');
  assert.ok(structure.methods.length >= 1, 'Should find at least 1 method');
  assert.ok(
    structure.methods.some((m) => m.name === 'execute'),
    'Should extract execute method'
  );
});

// ---------------------------------------------------------------------------
// 3. Parser: JS/TS Symbols
// ---------------------------------------------------------------------------
console.log('\n\x1b[36m[Group 3: JS/TS AST Parser]\x1b[0m');

test('parses TS imports, interfaces, types, and classes', () => {
  const tsCode = `import React, { useState, useEffect } from 'react';
import * as path from 'path';
import { ModelCatalog } from './ModelCatalog';

export interface UserProps {
  id: string;
  name: string;
}

export type Status = 'active' | 'suspended';

export class UserManager {
  private cache: Map<string, UserProps> = new Map();

  constructor() {}

  public getUser(id: string): UserProps | undefined {
    return this.cache.get(id);
  }
}
`;

  const structure = parseTsStructure(tsCode, 'UserManager.ts');

  assert.strictEqual(structure.uses.length, 3);
  assert.strictEqual(structure.containers.length, 3); // interface UserProps, type Status, class UserManager

  const iface = structure.containers.find((c) => c.name === 'UserProps');
  assert.ok(iface);
  assert.strictEqual(iface.kind, 'interface');

  const typeAlias = structure.containers.find((c) => c.name === 'Status');
  assert.ok(typeAlias);
  assert.strictEqual(typeAlias.kind, 'enum');

  const cls = structure.containers.find((c) => c.name === 'UserManager');
  assert.ok(cls);
  assert.strictEqual(cls.kind, 'class');

  assert.ok(structure.methods.some((m) => m.name === 'getUser'));
});

test('parses React TSX components and arrow functions', () => {
  const tsxCode = `import React from 'react';

export const UserCard: React.FC<{ name: string }> = ({ name }) => {
  return (
    <div className="card">
      <h3>{name}</h3>
    </div>
  );
};

export function renderUserList(users: string[]): JSX.Element {
  return (
    <ul>
      {users.map((u) => <UserCard key={u} name={u} />)}
    </ul>
  );
}
`;

  const structure = parseTsStructure(tsxCode, 'UserCard.tsx');

  assert.strictEqual(structure.uses.length, 1);
  assert.ok(
    structure.methods.some((m) => m.name === 'UserCard'),
    'Should extract arrow component UserCard'
  );
  assert.ok(
    structure.methods.some((m) => m.name === 'renderUserList'),
    'Should extract function renderUserList'
  );
});

// ---------------------------------------------------------------------------
// 4. Parser Dispatcher: parseStructureForFile
// ---------------------------------------------------------------------------
console.log('\n\x1b[36m[Group 4: Parser Dispatcher]\x1b[0m');

test('dispatches correctly according to file extension', () => {
  const phpResult = parseStructureForFile('Test.php', '<?php class Test {}');
  assert.strictEqual(phpResult.containers[0]?.name, 'Test');

  const tsResult = parseStructureForFile('Test.ts', 'class TsTest {}');
  assert.strictEqual(tsResult.containers[0]?.name, 'TsTest');

  const txtResult = parseStructureForFile('notes.txt', 'Just some notes');
  assert.strictEqual(txtResult.containers.length, 0);
  assert.strictEqual(txtResult.methods.length, 0);
});

test('parses non-code files (Markdown, JSON, YAML) as empty structure without AST errors', () => {
  const mdResult = parseStructureForFile('README.md', '# Title\n\nContent');
  assert.strictEqual(mdResult.containers.length, 0);
  assert.strictEqual(mdResult.methods.length, 0);
  assert.strictEqual(mdResult.linesCount, 3);

  const jsonResult = parseStructureForFile('package.json', '{\n  "name": "test"\n}');
  assert.strictEqual(jsonResult.containers.length, 0);
  assert.strictEqual(jsonResult.methods.length, 0);
  assert.strictEqual(jsonResult.linesCount, 3);
});

// ---------------------------------------------------------------------------
// 5. Diff Engine: computeLineDiff
// ---------------------------------------------------------------------------
console.log('\n\x1b[36m[Group 5: Line Diff Engine]\x1b[0m');

test('computes accurate line insertions, deletions, and unchanged lines', () => {
  const oldText = 'line1\nline2\nline3\n';
  const newText = 'line1\nmodified2\nline3\nline4\n';

  const lines = computeLineDiff(oldText, newText);

  assert.ok(lines.some((l) => l.type === 'unchanged' && l.content === 'line1'));
  assert.ok(lines.some((l) => l.type === 'delete' && l.content === 'line2'));
  assert.ok(lines.some((l) => l.type === 'insert' && l.content === 'modified2'));
  assert.ok(lines.some((l) => l.type === 'unchanged' && l.content === 'line3'));
  assert.ok(lines.some((l) => l.type === 'insert' && l.content === 'line4'));
});

// ---------------------------------------------------------------------------
// 6. Structural Builder: PHP & TS Diff Structures
// ---------------------------------------------------------------------------
console.log('\n\x1b[36m[Group 6: Structural Diff Builder]\x1b[0m');

test('builds structural diff for PHP file with collapsed unchanged method', () => {
  const oldPhp = `<?php
class Calculator {
  public function add(int $a, int $b): int {
    // line 1
    // line 2
    // line 3
    // line 4
    // line 5
    // line 6
    // line 7
    // line 8
    return $a + $b;
  }

  public function sub(int $a, int $b): int {
    return $a - $b;
  }
}
`;

  const newPhp = `<?php
class Calculator {
  public function add(int $a, int $b): int {
    // line 1
    // line 2
    // line 3
    // line 4
    // line 5
    // line 6
    // line 7
    // line 8
    return $a + $b;
  }

  public function sub(int $a, int $b): int {
    // modified
    return $a - $b;
  }
}
`;

  const lines = computeLineDiff(oldPhp, newPhp);
  const diff = buildStructuralDiff('src/Calculator.php', oldPhp, newPhp, lines);

  assert.strictEqual(diff.filePath, 'src/Calculator.php');
  assert.ok(diff.stats.added > 0);
  assert.ok(
    diff.items.some((item) => item.kind === 'expand'),
    'Should contain collapsed unchanged expand block'
  );
  assert.ok(diff.items.some((item) => item.kind === 'line' && item.line.content.includes('modified')));
});

test('builds structural diff for TS file with import additions', () => {
  const oldTs = `import { A } from './a';

export function run() {
  return 1;
}
`;

  const newTs = `import { A } from './a';
import { B } from './b';

export function run() {
  return 2;
}
`;

  const lines = computeLineDiff(oldTs, newTs);
  const diff = buildStructuralDiff('src/runner.ts', oldTs, newTs, lines);

  assert.strictEqual(diff.filePath, 'src/runner.ts');
  assert.ok(
    diff.items.some(
      (item) => item.kind === 'line' && item.line.type === 'insert' && item.line.content.includes("from './b'")
    )
  );
  assert.ok(
    diff.items.some(
      (item) => item.kind === 'line' && item.line.type === 'insert' && item.line.content.includes('return 2;')
    )
  );
});

test('builds diff for non-code files (Markdown, JSON) without AST parsing', () => {
  const oldMd = '# Old Title\nLine 2\n';
  const newMd = '# New Title\nLine 2\nLine 3\n';
  const lines = computeLineDiff(oldMd, newMd);
  const diff = buildStructuralDiff('README.md', oldMd, newMd, lines);

  assert.strictEqual(diff.filePath, 'README.md');
  assert.strictEqual(diff.stats.deleted, 1);
  assert.strictEqual(diff.stats.added, 2);
  assert.strictEqual(diff.stats.methodsCount, 0);
  assert.strictEqual(diff.summary.containers.length, 0);
  assert.strictEqual(diff.summary.methods.length, 0);
  assert.ok(diff.items.length > 0);
});

test('classifies method changeType strictly based on diff lines composition (added vs modified vs deleted)', () => {
  const oldPhp = `<?php
class Service {
  public function oldHelper() {
    return 1;
  }

  public function keptMethod() {
    $x = 10;
    return $x * 2;
  }
}
`;

  const newPhp = `<?php
class Service {
  public function keptMethod() {
    $x = 20; // modified
    return $x * 2;
  }

  public function brandNewHelper() {
    return 2;
  }
}
`;

  const lines = computeLineDiff(oldPhp, newPhp);
  const diff = buildStructuralDiff('src/Service.php', oldPhp, newPhp, lines);

  const kept = diff.summary.methods.find((m) => m.name === 'keptMethod');
  const brandNew = diff.summary.methods.find((m) => m.name === 'brandNewHelper');
  const oldHelper = diff.summary.methods.find((m) => m.name === 'oldHelper');

  assert.ok(kept, 'keptMethod should be in summary');
  assert.strictEqual(kept.changeType, 'modified', 'keptMethod should be modified (~), not added');

  assert.ok(brandNew, 'brandNewHelper should be in summary');
  assert.strictEqual(brandNew.changeType, 'added', 'brandNewHelper should be added (+)');

  assert.ok(oldHelper, 'oldHelper should be in summary');
  assert.strictEqual(oldHelper.changeType, 'deleted', 'oldHelper should be deleted (-)');
});

// ---------------------------------------------------------------------------
// 7. HTML Renderer
// ---------------------------------------------------------------------------
console.log('\n\x1b[36m[Group 7: Webview HTML Renderer]\x1b[0m');

test('renders valid HTML document with styles, scripts and diff items', () => {
  const lines = computeLineDiff('echo 1;', 'echo 2;');
  const diff = buildStructuralDiff('test.php', 'echo 1;', 'echo 2;', lines);
  const html = renderDiffHtml(diff);

  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('test.php'));
  assert.ok(html.includes('class="diff-row'));
  assert.ok(html.includes('<style>'));
  assert.ok(html.includes('<script>'));
});

test('renderDiffParts returns rowsHtml and summaryRowsHtml for live DOM updates', () => {
  const lines = computeLineDiff('echo 1;', 'echo 2;');
  const diff = buildStructuralDiff('test.php', 'echo 1;', 'echo 2;', lines);
  const parts = renderDiffParts(diff);

  assert.ok(typeof parts.rowsHtml === 'string');
  assert.ok(typeof parts.summaryRowsHtml === 'string');
  assert.ok(parts.rowsHtml.includes('class="diff-row'));
  assert.ok(parts.summaryRowsHtml.includes('class="summary-row'));
});

test('renderDiffParts produces valid tbody-free row markup for collapsible blocks', () => {
  const oldCode = `function a() {\n  return 1;\n}\n${'// unchanged line\n'.repeat(10)}function b() {\n  return 2;\n}\n`;
  const newCode = `function a() {\n  return 11;\n}\n${'// unchanged line\n'.repeat(10)}function b() {\n  return 2;\n}\n`;
  const lines = computeLineDiff(oldCode, newCode);
  const diff = buildStructuralDiff('test.ts', oldCode, newCode, lines);
  const parts = renderDiffParts(diff);

  assert.strictEqual(parts.rowsHtml.includes('<tbody'), false, 'rowsHtml must not contain nested tbody tags');
  assert.ok(parts.rowsHtml.includes('class="diff-row-expand"'), 'Must contain expand banner row');
  assert.ok(parts.rowsHtml.includes('hunk-hidden'), 'Must contain rows with hunk-hidden class');
  assert.ok(parts.rowsHtml.includes('style="display: none;"'), 'Hidden rows must have inline display: none');
});

test('renderBinaryNoticeHtml renders warning for binary files', () => {
  const html = renderBinaryNoticeHtml('assets/logo.png');
  assert.ok(html.includes('logo.png'));
  assert.ok(html.includes('Binary files cannot be displayed'));
  assert.ok(html.includes('<!DOCTYPE html>'));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n----------------------------------------');
console.log(`Test Results: \x1b[32m${passed} passed\x1b[0m, \x1b[${failed > 0 ? '31' : '32'}m${failed} failed\x1b[0m`);
console.log('----------------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
