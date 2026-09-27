import * as Diff from 'diff';

export interface DiffLine {
  type: 'insert' | 'delete' | 'unchanged';
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
  anchorId?: string;
}

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const changes = Diff.diffLines(oldText, newText);
  const result: DiffLine[] = [];

  let oldLine = 1;
  let newLine = 1;

  for (const part of changes) {
    // Split into individual lines
    const rawLines = part.value.replace(/\r\n/g, '\n').split('\n');
    // If ends with \n, split produces an empty string at end
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }

    if (part.added) {
      for (const line of rawLines) {
        result.push({
          type: 'insert',
          oldLineNumber: null,
          newLineNumber: newLine++,
          content: line,
        });
      }
    } else if (part.removed) {
      for (const line of rawLines) {
        result.push({
          type: 'delete',
          oldLineNumber: oldLine++,
          newLineNumber: null,
          content: line,
        });
      }
    } else {
      for (const line of rawLines) {
        result.push({
          type: 'unchanged',
          oldLineNumber: oldLine++,
          newLineNumber: newLine++,
          content: line,
        });
      }
    }
  }

  return result;
}
