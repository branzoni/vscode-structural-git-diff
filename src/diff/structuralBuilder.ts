import type { FileStructure, PhpSymbol } from '../parser/phpSymbols';
import { parseStructureForFile } from '../parser/symbolParser';
import type { DiffLine } from './diffEngine';

export interface StructuralItemLine {
  kind: 'line';
  line: DiffLine;
}

export interface StructuralItemHunkExpand {
  kind: 'expand';
  id: string;
  label: string;
  count: number;
  hiddenLines: DiffLine[];
}

export type StructuralItem = StructuralItemLine | StructuralItemHunkExpand;

export interface SymbolSummaryItem {
  kind: PhpSymbol['kind'];
  name: string;
  parentName?: string;
  changeType: 'added' | 'deleted' | 'modified';
  anchorId: string;
}

export interface StructuralDiffSummary {
  lines: {
    added: number;
    deleted: number;
  };
  uses: {
    added: string[];
    deleted: string[];
  };
  containers: SymbolSummaryItem[];
  methods: SymbolSummaryItem[];
  constants: SymbolSummaryItem[];
  properties: SymbolSummaryItem[];
}

export interface StructuralDiffResult {
  filePath: string;
  items: StructuralItem[];
  summary: StructuralDiffSummary;
  stats: {
    added: number;
    deleted: number;
    methodsCount: number;
  };
}

function makeAnchorId(kind: string, name: string, parentName?: string): string {
  const clean = `${kind}_${parentName ? `${parentName}_` : ''}${name}`.replace(/[^\w-]/g, '_').toLowerCase();
  return `sym_${clean}`;
}

export function buildStructuralDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
  diffLines: DiffLine[]
): StructuralDiffResult {
  const oldStruct = parseStructureForFile(filePath, oldContent);
  const newStruct = parseStructureForFile(filePath, newContent);

  const items: StructuralItem[] = [];
  let addedCount = 0;
  let deletedCount = 0;
  let expandIdCounter = 0;

  for (const l of diffLines) {
    if (l.type === 'insert') addedCount++;
    if (l.type === 'delete') deletedCount++;
  }

  // Helper: map line numbers to methods
  function getMethodForLine(lineNum: number | null, struct: FileStructure): PhpSymbol | undefined {
    if (lineNum === null) return undefined;
    return struct.methods.find((m) => lineNum >= m.range.startLine && lineNum <= m.range.endLine);
  }

  // Helper: check if line is an import
  function isUseLine(lineNum: number | null, struct: FileStructure): boolean {
    if (lineNum === null) return false;
    return struct.uses.some((u) => lineNum >= u.range.startLine && lineNum <= u.range.endLine);
  }

  // Extract changed uses
  const addedUses: string[] = [];
  const deletedUses: string[] = [];
  const seenAddedUses = new Set<string>();
  const seenDeletedUses = new Set<string>();

  for (const l of diffLines) {
    if (l.type === 'insert' && isUseLine(l.newLineNumber, newStruct)) {
      const sym = newStruct.uses.find(
        (u) => l.newLineNumber !== null && l.newLineNumber >= u.range.startLine && l.newLineNumber <= u.range.endLine
      );
      const name = sym
        ? sym.name
        : l.content.match(/(?:use|from)\s+['"]?([^'";]+)['"]?/)?.[1]?.trim() || l.content.trim();
      if (name && !seenAddedUses.has(name)) {
        seenAddedUses.add(name);
        addedUses.push(name);
      }
    } else if (l.type === 'delete' && isUseLine(l.oldLineNumber, oldStruct)) {
      const sym = oldStruct.uses.find(
        (u) => l.oldLineNumber !== null && l.oldLineNumber >= u.range.startLine && l.oldLineNumber <= u.range.endLine
      );
      const name = sym
        ? sym.name
        : l.content.match(/(?:use|from)\s+['"]?([^'";]+)['"]?/)?.[1]?.trim() || l.content.trim();
      if (name && !seenDeletedUses.has(name)) {
        seenDeletedUses.add(name);
        deletedUses.push(name);
      }
    }
  }

  // Helper: analyze diff line composition for a symbol
  function analyzeSymbolDiff(
    sym: PhpSymbol,
    diffs: DiffLine[],
    isNew: boolean,
    counterpart?: PhpSymbol
  ): { unchangedCount: number; insertCount: number; deleteCount: number } {
    let firstIdx = -1;
    let lastIdx = -1;

    for (let i = 0; i < diffs.length; i++) {
      const l = diffs[i];
      const lineNum = isNew ? l.newLineNumber : l.oldLineNumber;
      if (lineNum !== null && lineNum >= sym.range.startLine && lineNum <= sym.range.endLine) {
        if (firstIdx === -1) firstIdx = i;
        lastIdx = i;
      }
    }

    if (firstIdx === -1) {
      return { unchangedCount: 0, insertCount: 0, deleteCount: 0 };
    }

    let sliceStart = firstIdx;
    if (isNew && counterpart) {
      while (
        sliceStart > 0 &&
        diffs[sliceStart - 1].type === 'delete' &&
        diffs[sliceStart - 1].oldLineNumber !== null &&
        diffs[sliceStart - 1].oldLineNumber! >= counterpart.range.startLine &&
        diffs[sliceStart - 1].oldLineNumber! <= counterpart.range.endLine
      ) {
        sliceStart--;
      }
    }

    let sliceEnd = lastIdx;
    if (isNew && counterpart) {
      while (
        sliceEnd < diffs.length - 1 &&
        diffs[sliceEnd + 1].type === 'delete' &&
        diffs[sliceEnd + 1].oldLineNumber !== null &&
        diffs[sliceEnd + 1].oldLineNumber! >= counterpart.range.startLine &&
        diffs[sliceEnd + 1].oldLineNumber! <= counterpart.range.endLine
      ) {
        sliceEnd++;
      }
    }

    const slice = diffs.slice(sliceStart, sliceEnd + 1);
    let unchangedCount = 0;
    let insertCount = 0;
    let deleteCount = 0;

    for (const l of slice) {
      if (l.type === 'unchanged') {
        const trimmed = l.content.trim();
        if (trimmed !== '}' && trimmed !== '{' && trimmed !== '') {
          unchangedCount++;
        }
      } else if (l.type === 'insert') {
        insertCount++;
      } else if (l.type === 'delete') {
        deleteCount++;
      }
    }

    return { unchangedCount, insertCount, deleteCount };
  }

  // Track methods
  const methodsSummary: SymbolSummaryItem[] = [];
  const processedMethodKeys = new Set<string>();

  for (const mNew of newStruct.methods) {
    const key = `${mNew.parentName ?? ''}::${mNew.name}`;
    const mOld = oldStruct.methods.find(
      (m) => (m.parentName ?? '') === (mNew.parentName ?? '') && m.name === mNew.name
    );
    const diffStat = analyzeSymbolDiff(mNew, diffLines, true, mOld);

    if (diffStat.insertCount > 0 || diffStat.deleteCount > 0) {
      processedMethodKeys.add(key);
      let changeType: 'added' | 'modified' = 'modified';
      if (diffStat.unchangedCount === 0) {
        if (!mOld || diffStat.deleteCount === 0) {
          changeType = 'added';
        }
      }

      const anchorId = makeAnchorId(mNew.kind, mNew.name, mNew.parentName);
      methodsSummary.push({
        kind: mNew.kind,
        name: mNew.name,
        parentName: mNew.parentName,
        changeType,
        anchorId,
      });

      let target = diffLines.find((l) => l.newLineNumber === mNew.range.startLine);
      if (!target) {
        target = diffLines.find(
          (l) =>
            l.newLineNumber !== null && l.newLineNumber >= mNew.range.startLine && l.newLineNumber <= mNew.range.endLine
        );
      }
      if (target) target.anchorId = anchorId;
    }
  }

  for (const mOld of oldStruct.methods) {
    const key = `${mOld.parentName ?? ''}::${mOld.name}`;
    if (processedMethodKeys.has(key)) continue;

    const diffStat = analyzeSymbolDiff(mOld, diffLines, false);
    if (diffStat.deleteCount > 0 && diffStat.unchangedCount === 0) {
      const anchorId = makeAnchorId(mOld.kind, mOld.name, mOld.parentName);
      methodsSummary.push({
        kind: mOld.kind,
        name: mOld.name,
        parentName: mOld.parentName,
        changeType: 'deleted',
        anchorId,
      });

      let target = diffLines.find((l) => l.oldLineNumber === mOld.range.startLine);
      if (!target) {
        target = diffLines.find(
          (l) =>
            l.oldLineNumber !== null && l.oldLineNumber >= mOld.range.startLine && l.oldLineNumber <= mOld.range.endLine
        );
      }
      if (target) target.anchorId = anchorId;
    }
  }

  // Track constants
  const constantsSummary: SymbolSummaryItem[] = [];
  const processedConstKeys = new Set<string>();

  for (const cNew of newStruct.constants) {
    const key = `${cNew.parentName ?? ''}::${cNew.name}`;
    const cOld = oldStruct.constants.find(
      (c) => (c.parentName ?? '') === (cNew.parentName ?? '') && c.name === cNew.name
    );
    const diffStat = analyzeSymbolDiff(cNew, diffLines, true, cOld);

    if (diffStat.insertCount > 0 || diffStat.deleteCount > 0) {
      processedConstKeys.add(key);
      let changeType: 'added' | 'modified' = 'modified';
      if (diffStat.unchangedCount === 0) {
        if (!cOld || diffStat.deleteCount === 0) {
          changeType = 'added';
        }
      }

      const anchorId = makeAnchorId('constant', cNew.name, cNew.parentName);
      constantsSummary.push({
        kind: 'constant',
        name: cNew.name,
        parentName: cNew.parentName,
        changeType,
        anchorId,
      });

      let target = diffLines.find((l) => l.newLineNumber === cNew.range.startLine);
      if (!target) {
        target = diffLines.find(
          (l) =>
            l.newLineNumber !== null && l.newLineNumber >= cNew.range.startLine && l.newLineNumber <= cNew.range.endLine
        );
      }
      if (target) target.anchorId = anchorId;
    }
  }

  for (const cOld of oldStruct.constants) {
    const key = `${cOld.parentName ?? ''}::${cOld.name}`;
    if (processedConstKeys.has(key)) continue;

    const diffStat = analyzeSymbolDiff(cOld, diffLines, false);
    if (diffStat.deleteCount > 0 && diffStat.unchangedCount === 0) {
      const anchorId = makeAnchorId('constant', cOld.name, cOld.parentName);
      constantsSummary.push({
        kind: 'constant',
        name: cOld.name,
        parentName: cOld.parentName,
        changeType: 'deleted',
        anchorId,
      });

      let target = diffLines.find((l) => l.oldLineNumber === cOld.range.startLine);
      if (!target) {
        target = diffLines.find(
          (l) =>
            l.oldLineNumber !== null && l.oldLineNumber >= cOld.range.startLine && l.oldLineNumber <= cOld.range.endLine
        );
      }
      if (target) target.anchorId = anchorId;
    }
  }

  // Track properties
  const propertiesSummary: SymbolSummaryItem[] = [];
  const processedPropKeys = new Set<string>();

  for (const pNew of newStruct.properties) {
    const key = `${pNew.parentName ?? ''}::${pNew.name}`;
    const pOld = oldStruct.properties.find(
      (p) => (p.parentName ?? '') === (pNew.parentName ?? '') && p.name === pNew.name
    );
    const diffStat = analyzeSymbolDiff(pNew, diffLines, true, pOld);

    if (diffStat.insertCount > 0 || diffStat.deleteCount > 0) {
      processedPropKeys.add(key);
      let changeType: 'added' | 'modified' = 'modified';
      if (diffStat.unchangedCount === 0) {
        if (!pOld || diffStat.deleteCount === 0) {
          changeType = 'added';
        }
      }

      const anchorId = makeAnchorId('property', pNew.name, pNew.parentName);
      propertiesSummary.push({
        kind: 'property',
        name: pNew.name,
        parentName: pNew.parentName,
        changeType,
        anchorId,
      });

      let target = diffLines.find((l) => l.newLineNumber === pNew.range.startLine);
      if (!target) {
        target = diffLines.find(
          (l) =>
            l.newLineNumber !== null && l.newLineNumber >= pNew.range.startLine && l.newLineNumber <= pNew.range.endLine
        );
      }
      if (target) target.anchorId = anchorId;
    }
  }

  for (const pOld of oldStruct.properties) {
    const key = `${pOld.parentName ?? ''}::${pOld.name}`;
    if (processedPropKeys.has(key)) continue;

    const diffStat = analyzeSymbolDiff(pOld, diffLines, false);
    if (diffStat.deleteCount > 0 && diffStat.unchangedCount === 0) {
      const anchorId = makeAnchorId('property', pOld.name, pOld.parentName);
      propertiesSummary.push({
        kind: 'property',
        name: pOld.name,
        parentName: pOld.parentName,
        changeType: 'deleted',
        anchorId,
      });

      let target = diffLines.find((l) => l.oldLineNumber === pOld.range.startLine);
      if (!target) {
        target = diffLines.find(
          (l) =>
            l.oldLineNumber !== null && l.oldLineNumber >= pOld.range.startLine && l.oldLineNumber <= pOld.range.endLine
        );
      }
      if (target) target.anchorId = anchorId;
    }
  }

  // Track containers
  const containersSummary: SymbolSummaryItem[] = [];
  for (const cNew of newStruct.containers) {
    const cOld = oldStruct.containers.find((c) => c.name === cNew.name);
    if (!cOld) {
      const anchorId = makeAnchorId(cNew.kind, cNew.name);
      containersSummary.push({
        kind: cNew.kind,
        name: cNew.name,
        changeType: 'added',
        anchorId,
      });
      const target = diffLines.find((l) => l.newLineNumber === cNew.range.startLine);
      if (target) target.anchorId = anchorId;
    } else {
      const headerChanged = diffLines.some((l) => {
        if (l.type === 'insert' && l.newLineNumber !== null) {
          return (
            l.newLineNumber >= cNew.range.startLine &&
            l.newLineNumber <= Math.min(cNew.range.startLine + 2, cNew.range.endLine)
          );
        }
        if (l.type === 'delete' && l.oldLineNumber !== null) {
          return (
            l.oldLineNumber >= cOld.range.startLine &&
            l.oldLineNumber <= Math.min(cOld.range.startLine + 2, cOld.range.endLine)
          );
        }
        return false;
      });
      if (headerChanged) {
        const anchorId = makeAnchorId(cNew.kind, cNew.name);
        containersSummary.push({
          kind: cNew.kind,
          name: cNew.name,
          changeType: 'modified',
          anchorId,
        });
        const target = diffLines.find((l) => l.newLineNumber === cNew.range.startLine);
        if (target) target.anchorId = anchorId;
      }
    }
  }

  for (const cOld of oldStruct.containers) {
    const exists = newStruct.containers.some((c) => c.name === cOld.name);
    if (!exists) {
      const anchorId = makeAnchorId(cOld.kind, cOld.name);
      containersSummary.push({
        kind: cOld.kind,
        name: cOld.name,
        changeType: 'deleted',
        anchorId,
      });
      const target = diffLines.find((l) => l.oldLineNumber === cOld.range.startLine);
      if (target) target.anchorId = anchorId;
    }
  }

  const summary: StructuralDiffSummary = {
    lines: {
      added: addedCount,
      deleted: deletedCount,
    },
    uses: {
      added: addedUses,
      deleted: deletedUses,
    },
    containers: containersSummary,
    methods: methodsSummary,
    constants: constantsSummary,
    properties: propertiesSummary,
  };

  // Pre-identify all methods that have changes
  const modifiedMethodNames = new Set<string>();
  for (const l of diffLines) {
    if (l.type === 'insert' || l.type === 'delete') {
      const mNew = getMethodForLine(l.newLineNumber, newStruct);
      const mOld = getMethodForLine(l.oldLineNumber, oldStruct);
      if (mNew) modifiedMethodNames.add(`${mNew.parentName ?? ''}::${mNew.name}`);
      if (mOld) modifiedMethodNames.add(`${mOld.parentName ?? ''}::${mOld.name}`);
    }
  }

  let i = 0;
  while (i < diffLines.length) {
    const cur = diffLines[i];

    // Rule 2: Top-level single items outside methods (like `use` imports)
    const curIsOldUse = isUseLine(cur.oldLineNumber, oldStruct);
    const curIsNewUse = isUseLine(cur.newLineNumber, newStruct);

    if (curIsOldUse || curIsNewUse) {
      if (cur.type === 'insert' || cur.type === 'delete') {
        // Changed import: output solo!
        items.push({ kind: 'line', line: cur });
      }
      // Unchanged import: completely skip / suppress
      i++;
      continue;
    }

    // Check if line belongs to a method
    const mNew = getMethodForLine(cur.newLineNumber, newStruct);
    const mOld = getMethodForLine(cur.oldLineNumber, oldStruct);
    const method = mNew || mOld;
    const methodKey = method ? `${method.parentName ?? ''}::${method.name}` : undefined;
    const isMethodActive = methodKey && modifiedMethodNames.has(methodKey);

    if (isMethodActive && method) {
      // Collect all diff lines belonging to this method
      const methodDiffLines: DiffLine[] = [];
      while (i < diffLines.length) {
        const next = diffLines[i];
        const nextMNew = getMethodForLine(next.newLineNumber, newStruct);
        const nextMOld = getMethodForLine(next.oldLineNumber, oldStruct);
        const nextMethod = nextMNew || nextMOld;
        const nextKey = nextMethod ? `${nextMethod.parentName ?? ''}::${nextMethod.name}` : undefined;

        if (nextKey === methodKey) {
          methodDiffLines.push(next);
          i++;
        } else {
          break;
        }
      }

      // Check if entire method was deleted
      const isDeletedMethod = methodDiffLines.every((l) => l.type === 'delete');
      const isLargeDeleted = isDeletedMethod && methodDiffLines.length > 30;

      if (isLargeDeleted) {
        // Output signature
        items.push({ kind: 'line', line: methodDiffLines[0] });
        if (methodDiffLines.length > 1) {
          items.push({ kind: 'line', line: methodDiffLines[1] });
        }
        // Collapse middle
        const middle = methodDiffLines.slice(2, methodDiffLines.length - 1);
        if (middle.length > 0) {
          items.push({
            kind: 'expand',
            id: `exp_${++expandIdCounter}`,
            label: `@@ ↕ show deleted lines from ${middle[0].oldLineNumber} to ${middle[middle.length - 1].oldLineNumber} (${middle.length} lines) ↕ @@`,
            count: middle.length,
            hiddenLines: middle,
          });
        }
        // Output closing brace
        items.push({ kind: 'line', line: methodDiffLines[methodDiffLines.length - 1] });
      } else {
        // Regular modified method: Rule 1: Method keeps structural integrity
        // If length > 50 and has a large unchanged gap >= 20 lines, collapse that gap
        if (methodDiffLines.length > 50) {
          let j = 0;
          while (j < methodDiffLines.length) {
            if (methodDiffLines[j].type === 'unchanged') {
              const gap: DiffLine[] = [];
              while (j < methodDiffLines.length && methodDiffLines[j].type === 'unchanged') {
                gap.push(methodDiffLines[j]);
                j++;
              }
              if (gap.length >= 20) {
                items.push({
                  kind: 'expand',
                  id: `exp_${++expandIdCounter}`,
                  label: `@@ ↕ ${gap.length} unchanged lines ↕ @@`,
                  count: gap.length,
                  hiddenLines: gap,
                });
              } else {
                for (const gl of gap) items.push({ kind: 'line', line: gl });
              }
            } else {
              items.push({ kind: 'line', line: methodDiffLines[j] });
              j++;
            }
          }
        } else {
          // Output all lines of method directly (unchanged will be dimmed)
          for (const ml of methodDiffLines) {
            items.push({ kind: 'line', line: ml });
          }
        }
      }
      continue;
    }

    // Outside of active methods (e.g. unchanged code, class declaration, unchanged methods)
    if (cur.type === 'unchanged') {
      const outsideBatch: DiffLine[] = [];
      while (i < diffLines.length) {
        const next = diffLines[i];
        if (next.type !== 'unchanged') break;

        const nextM =
          getMethodForLine(next.newLineNumber, newStruct) || getMethodForLine(next.oldLineNumber, oldStruct);
        const nextKey = nextM ? `${nextM.parentName ?? ''}::${nextM.name}` : undefined;
        if (nextKey && modifiedMethodNames.has(nextKey)) break;

        // Skip unchanged use lines
        if (isUseLine(next.oldLineNumber, oldStruct) || isUseLine(next.newLineNumber, newStruct)) {
          i++;
          continue;
        }

        outsideBatch.push(next);
        i++;
      }

      if (outsideBatch.length >= 6) {
        items.push({
          kind: 'expand',
          id: `exp_${++expandIdCounter}`,
          label: `@@ ↕ ${outsideBatch.length} unchanged lines ↕ @@`,
          count: outsideBatch.length,
          hiddenLines: outsideBatch,
        });
      } else {
        for (const ol of outsideBatch) {
          items.push({ kind: 'line', line: ol });
        }
      }
      continue;
    }

    // Any other changed line (e.g. class level property or comment)
    items.push({ kind: 'line', line: cur });
    i++;
  }

  return {
    filePath,
    items,
    summary,
    stats: {
      added: addedCount,
      deleted: deletedCount,
      methodsCount: newStruct.methods.length,
    },
  };
}
