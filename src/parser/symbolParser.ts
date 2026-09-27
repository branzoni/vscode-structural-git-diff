import { FileStructure, parsePhpStructure } from './phpSymbols';
import { parseTsStructure } from './tsSymbols';

export function parseStructureForFile(filePath: string, code: string): FileStructure {
  if (/\.[jt]sx?$/i.test(filePath) || /\.(m|c)?[jt]s$/i.test(filePath)) {
    return parseTsStructure(code, filePath);
  }
  if (/\.php$/i.test(filePath)) {
    return parsePhpStructure(code);
  }
  // Plain text / non-code files (JSON, Markdown, YAML, CSS, HTML, SQL, etc.)
  const linesCount = code.split('\n').length;
  return {
    uses: [],
    containers: [],
    methods: [],
    properties: [],
    constants: [],
    linesCount,
  };
}

export { FileStructure, parsePhpStructure, parseTsStructure };
