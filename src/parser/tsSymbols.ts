import * as ts from 'typescript';
import type { FileStructure, SymbolRange } from './phpSymbols';

const tsCache = new Map<string, FileStructure>();
const MAX_TS_CACHE = 100;

export function parseTsStructure(code: string, fileName = 'file.tsx'): FileStructure {
  if (!code || !code.trim()) {
    return {
      uses: [],
      containers: [],
      methods: [],
      properties: [],
      constants: [],
      linesCount: 0,
    };
  }

  const linesCount = code.split('\n').length;
  const cacheKey = `${fileName}:${code.length}:${code.slice(0, 80)}:${code.slice(-80)}`;
  const cached = tsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const result: FileStructure = {
    uses: [],
    containers: [],
    methods: [],
    properties: [],
    constants: [],
    linesCount,
  };

  const scriptKind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : fileName.endsWith('.ts')
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, scriptKind);
  } catch {
    return result;
  }

  function getRange(node: ts.Node): SymbolRange {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    return {
      startLine: start.line + 1,
      endLine: end.line + 1,
    };
  }

  function visit(node: ts.Node, currentContainer?: string) {
    // 1. Imports
    if (ts.isImportDeclaration(node)) {
      const moduleName = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
      const range = getRange(node);
      result.uses.push({
        kind: 'use',
        name: moduleName,
        range,
      });
      return;
    }

    // 2. Export declarations with module specifier: export * from './foo'
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const moduleName = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
      const range = getRange(node);
      result.uses.push({
        kind: 'use',
        name: moduleName,
        range,
      });
      return;
    }

    // 3. Classes
    if (ts.isClassDeclaration(node)) {
      const name = node.name?.getText(sourceFile) || 'AnonymousClass';
      const range = getRange(node);
      result.containers.push({
        kind: 'class',
        name,
        range,
      });

      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member)) {
          result.methods.push({
            kind: 'method',
            name: 'constructor',
            parentName: name,
            range: getRange(member),
            isConstructor: true,
          });
        } else if (ts.isMethodDeclaration(member)) {
          const methodName = member.name.getText(sourceFile);
          result.methods.push({
            kind: 'method',
            name: methodName,
            parentName: name,
            range: getRange(member),
          });
        } else if (ts.isPropertyDeclaration(member)) {
          const propName = member.name.getText(sourceFile);
          result.properties.push({
            kind: 'property',
            name: propName,
            parentName: name,
            range: getRange(member),
          });
        }
      }
      return;
    }

    // 4. Interfaces
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.getText(sourceFile);
      result.containers.push({
        kind: 'interface',
        name,
        range: getRange(node),
      });
      return;
    }

    // 5. Type Aliases
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.getText(sourceFile);
      result.containers.push({
        kind: 'enum',
        name,
        range: getRange(node),
      });
      return;
    }

    // 6. Enums
    if (ts.isEnumDeclaration(node)) {
      const name = node.name.getText(sourceFile);
      result.containers.push({
        kind: 'enum',
        name,
        range: getRange(node),
      });
      return;
    }

    // 7. Functions
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.getText(sourceFile) || 'anonymous';
      result.methods.push({
        kind: 'function',
        name,
        parentName: currentContainer,
        range: getRange(node),
      });
      return;
    }

    // 8. Variable statements (const / let): functions, arrow components, constants
    if (ts.isVariableStatement(node)) {
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const decl of node.declarationList.declarations) {
        const varName = decl.name.getText(sourceFile);
        if (decl.initializer) {
          if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
            result.methods.push({
              kind: 'function',
              name: varName,
              parentName: currentContainer,
              range: getRange(node),
            });
            continue;
          }
          // require() call
          if (
            ts.isCallExpression(decl.initializer) &&
            decl.initializer.expression.getText(sourceFile) === 'require' &&
            decl.initializer.arguments.length > 0
          ) {
            const reqPath = decl.initializer.arguments[0].getText(sourceFile).replace(/['"]/g, '');
            result.uses.push({
              kind: 'use',
              name: reqPath,
              range: getRange(node),
            });
            continue;
          }
        }

        if (isConst) {
          result.constants.push({
            kind: 'constant',
            name: varName,
            parentName: currentContainer,
            range: getRange(node),
          });
        } else {
          result.properties.push({
            kind: 'property',
            name: varName,
            parentName: currentContainer,
            range: getRange(node),
          });
        }
      }
      return;
    }

    ts.forEachChild(node, (child) => visit(child, currentContainer));
  }

  ts.forEachChild(sourceFile, visit);

  if (tsCache.size >= MAX_TS_CACHE) {
    const oldestKey = tsCache.keys().next().value;
    if (oldestKey) tsCache.delete(oldestKey);
  }
  tsCache.set(cacheKey, result);

  return result;
}
