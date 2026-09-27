import { Engine } from 'php-parser';

export interface SymbolRange {
  startLine: number;
  endLine: number;
}

export interface PhpSymbol {
  kind: 'use' | 'class' | 'interface' | 'trait' | 'enum' | 'method' | 'function' | 'property' | 'constant';
  name: string;
  parentName?: string;
  range: SymbolRange;
  isConstructor?: boolean;
}

export interface FileStructure {
  namespace?: { name: string; range: SymbolRange };
  uses: PhpSymbol[];
  containers: PhpSymbol[]; // classes, interfaces, traits, enums
  methods: PhpSymbol[]; // methods & functions
  properties: PhpSymbol[];
  constants: PhpSymbol[];
  linesCount: number;
}

const parserEngine = new Engine({
  parser: {
    extractDoc: true,
  },
  ast: {
    withPositions: true,
    withSource: true,
  },
});

const astCache = new Map<string, FileStructure>();
const MAX_AST_CACHE = 100;

function regexFallbackParse(code: string, linesCount: number): FileStructure {
  const result: FileStructure = {
    uses: [],
    containers: [],
    methods: [],
    properties: [],
    constants: [],
    linesCount,
  };

  const lines = code.split('\n');
  let currentClass: string | undefined;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const lineNum = idx + 1;
    // Namespace
    const nsMatch = line.match(/^\s*namespace\s+([^;{]+)[;{]/);
    if (nsMatch) {
      result.namespace = {
        name: nsMatch[1].trim(),
        range: { startLine: lineNum, endLine: lineNum },
      };
      continue;
    }

    // Class/interface/trait/enum
    const containerMatch = line.match(/\b(class|interface|trait|enum)\s+([a-zA-Z0-9_]+)/);
    if (containerMatch) {
      const kind = containerMatch[1] as any;
      const name = containerMatch[2];
      currentClass = name;
      result.containers.push({
        kind,
        name,
        range: { startLine: lineNum, endLine: lineNum },
      });
      continue;
    }

    // Use (top-level import)
    const useMatch = line.match(/^\s*use\s+([^;]+);/);
    if (useMatch && !currentClass) {
      result.uses.push({
        kind: 'use',
        name: useMatch[1].trim(),
        range: { startLine: lineNum, endLine: lineNum },
      });
      continue;
    }

    // Method / Function
    const fnMatch = line.match(/\bfunction\s+([a-zA-Z0-9_]+)\s*\(/);
    if (fnMatch) {
      const name = fnMatch[1];
      result.methods.push({
        kind: currentClass ? 'method' : 'function',
        name,
        parentName: currentClass,
        range: { startLine: lineNum, endLine: lineNum },
        isConstructor: name === '__construct',
      });
      continue;
    }

    // Constant
    const constMatch = line.match(/\bconst\s+([a-zA-Z0-9_]+)\s*=/);
    if (constMatch) {
      result.constants.push({
        kind: 'constant',
        name: constMatch[1],
        parentName: currentClass,
        range: { startLine: lineNum, endLine: lineNum },
      });
    }
  }

  return result;
}

function fallbackTokenParse(code: string, linesCount: number): FileStructure {
  const result: FileStructure = {
    uses: [],
    containers: [],
    methods: [],
    properties: [],
    constants: [],
    linesCount,
  };

  let tokens: any[] = [];
  try {
    tokens = parserEngine.tokenGetAll(code);
  } catch {
    return regexFallbackParse(code, linesCount);
  }

  let currentContainer: { kind: 'class' | 'interface' | 'trait' | 'enum'; name: string; range: SymbolRange } | null =
    null;
  let containerBraceDepth = 0;
  let currentBraceDepth = 0;
  let lastDocCommentLine: number | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const type = Array.isArray(tok) ? tok[0] : tok;
    const _text = Array.isArray(tok) ? tok[1] : tok;
    const line = Array.isArray(tok) ? tok[2] : null;

    if (type === 'T_DOC_COMMENT' && line) {
      lastDocCommentLine = line;
      continue;
    }

    if (tok === '{') {
      currentBraceDepth++;
      lastDocCommentLine = null;
      continue;
    }
    if (tok === '}') {
      if (currentContainer && currentBraceDepth === containerBraceDepth) {
        currentContainer.range.endLine = line || currentContainer.range.startLine;
        currentContainer = null;
      }
      currentBraceDepth--;
      lastDocCommentLine = null;
      continue;
    }

    // NAMESPACE
    if (type === 'T_NAMESPACE' && currentBraceDepth === 0) {
      const startLine = line || 1;
      let nsText = '';
      let endLine = line || 1;
      i++;
      while (i < tokens.length && tokens[i] !== ';' && tokens[i] !== '{') {
        const nTok = tokens[i];
        const nText = Array.isArray(nTok) ? nTok[1] : nTok;
        const nLine = Array.isArray(nTok) ? nTok[2] : null;
        if (nLine) endLine = nLine;
        nsText += nText;
        i++;
      }
      result.namespace = {
        name: nsText.trim(),
        range: { startLine, endLine: endLine || startLine },
      };
      lastDocCommentLine = null;
      continue;
    }

    // USE
    if (type === 'T_USE' && currentBraceDepth === 0) {
      const startLine = line || 1;
      let useText = '';
      let endLine = line || 1;
      i++;
      while (i < tokens.length && tokens[i] !== ';') {
        const uTok = tokens[i];
        const uText = Array.isArray(uTok) ? uTok[1] : uTok;
        const uLine = Array.isArray(uTok) ? uTok[2] : null;
        if (uLine) endLine = uLine;
        useText += uText;
        i++;
      }
      result.uses.push({
        kind: 'use',
        name: useText.trim(),
        range: { startLine, endLine: endLine || startLine },
      });
      lastDocCommentLine = null;
      continue;
    }

    // CLASS / INTERFACE / TRAIT / ENUM
    if (
      (type === 'T_CLASS' || type === 'T_INTERFACE' || type === 'T_TRAIT' || type === 'T_ENUM') &&
      currentBraceDepth === 0
    ) {
      const kind =
        type === 'T_CLASS' ? 'class' : type === 'T_INTERFACE' ? 'interface' : type === 'T_TRAIT' ? 'trait' : 'enum';
      const startLine = line || 1;
      let name = '';
      let j = i + 1;
      while (j < tokens.length && tokens[j] !== '{') {
        const cTok = tokens[j];
        if (Array.isArray(cTok) && cTok[0] === 'T_STRING' && !name) {
          name = cTok[1];
        }
        j++;
      }
      if (name) {
        const container = {
          kind: kind as 'class' | 'interface' | 'trait' | 'enum',
          name,
          range: { startLine, endLine: startLine },
        };
        result.containers.push(container);
        currentContainer = container;
        containerBraceDepth = currentBraceDepth + 1;
      }
      lastDocCommentLine = null;
      continue;
    }

    // CONST
    if (type === 'T_CONST') {
      const startLine = line || 1;
      let name = '';
      let endLine = startLine;
      let j = i + 1;
      while (j < tokens.length && tokens[j] !== ';') {
        const cTok = tokens[j];
        if (Array.isArray(cTok) && cTok[0] === 'T_STRING' && !name) {
          name = cTok[1];
        }
        const cLine = Array.isArray(cTok) ? cTok[2] : null;
        if (cLine) endLine = cLine;
        j++;
      }
      if (name) {
        result.constants.push({
          kind: 'constant',
          name,
          parentName: currentContainer ? currentContainer.name : undefined,
          range: { startLine, endLine },
        });
      }
      lastDocCommentLine = null;
      continue;
    }

    // FUNCTION / METHOD
    if (type === 'T_FUNCTION') {
      const effectiveStart =
        lastDocCommentLine !== null && line !== null && line - lastDocCommentLine <= 2 ? lastDocCommentLine : line || 1;
      const startLine = effectiveStart;

      let name = '';
      let j = i + 1;
      while (j < tokens.length && tokens[j] !== '(' && tokens[j] !== '{' && tokens[j] !== ';') {
        const mTok = tokens[j];
        if (Array.isArray(mTok) && mTok[0] === 'T_STRING' && !name) {
          name = mTok[1];
        }
        j++;
      }
      if (name) {
        let endLine = line || startLine;
        let fnBraceDepth = 0;
        let foundOpenBrace = false;
        let k = j;
        while (k < tokens.length) {
          const fTok = tokens[k];
          const fLine = Array.isArray(fTok) ? fTok[2] : null;
          if (fLine) endLine = fLine;

          if (fTok === '{') {
            fnBraceDepth++;
            foundOpenBrace = true;
          } else if (fTok === '}') {
            fnBraceDepth--;
            if (fnBraceDepth <= 0 && foundOpenBrace) {
              break;
            }
          } else if (fTok === ';' && !foundOpenBrace) {
            break;
          }
          k++;
        }
        result.methods.push({
          kind: currentContainer ? 'method' : 'function',
          name,
          parentName: currentContainer ? currentContainer.name : undefined,
          range: { startLine, endLine },
          isConstructor: name === '__construct',
        });
      }
      lastDocCommentLine = null;
      continue;
    }

    if (type !== 'T_WHITESPACE' && type !== 'T_COMMENT') {
      lastDocCommentLine = null;
    }
  }

  return result;
}

export function parsePhpStructure(code: string): FileStructure {
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

  // Fast hash key based on length and boundary snippets
  const cacheKey = `${code.length}:${code.slice(0, 80)}:${code.slice(-80)}`;
  const cached = astCache.get(cacheKey);
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

  let ast: any;
  try {
    ast = parserEngine.parseCode(code, 'file.php');
  } catch {
    // If strict AST parsing fails (e.g. PHP 8.4 syntax, syntax errors),
    // use resilient token-based scanner to extract symbols!
    const fallback = fallbackTokenParse(code, linesCount);
    if (astCache.size >= MAX_AST_CACHE) {
      const oldestKey = astCache.keys().next().value;
      if (oldestKey) astCache.delete(oldestKey);
    }
    astCache.set(cacheKey, fallback);
    return fallback;
  }

  // Cache successful parse result
  if (astCache.size >= MAX_AST_CACHE) {
    const oldestKey = astCache.keys().next().value;
    if (oldestKey) astCache.delete(oldestKey);
  }
  astCache.set(cacheKey, result);

  function traverse(node: any, currentContainer?: string) {
    if (!node || typeof node !== 'object') return;

    const kind = node.kind;
    const loc = node.loc;
    const startLine = loc?.start?.line ?? 1;
    const endLine = loc?.end?.line ?? startLine;
    if (kind === 'namespace') {
      const name = typeof node.name === 'string' ? node.name : node.name?.name || '';
      result.namespace = {
        name,
        range: { startLine, endLine },
      };
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          traverse(child, currentContainer);
        }
      }
      return;
    }

    if (kind === 'usegroup') {
      const items = node.items || [];
      const name = items.map((it: any) => it.name).join(', ') || 'use';
      result.uses.push({
        kind: 'use',
        name,
        range: { startLine, endLine },
      });
      return;
    }

    if (kind === 'class' || kind === 'interface' || kind === 'trait' || kind === 'enum') {
      const name = typeof node.name === 'string' ? node.name : node.name?.name || 'anonymous';
      result.containers.push({
        kind,
        name,
        range: { startLine, endLine },
      });

      // Traverse children of class/trait/interface
      const body = node.body || [];
      if (Array.isArray(body)) {
        for (const member of body) {
          traverse(member, name);
        }
      }
      return;
    }

    if (kind === 'method') {
      const name = typeof node.name === 'string' ? node.name : node.name?.name || 'anonymous';
      const docStart = node.leadingComments?.[0]?.loc?.start?.line;
      const effectiveStart = typeof docStart === 'number' && docStart > 0 ? docStart : startLine;
      result.methods.push({
        kind: 'method',
        name,
        parentName: currentContainer,
        range: { startLine: effectiveStart, endLine },
        isConstructor: name === '__construct',
      });
      return;
    }

    if (kind === 'function') {
      const name = typeof node.name === 'string' ? node.name : node.name?.name || 'anonymous';
      const docStart = node.leadingComments?.[0]?.loc?.start?.line;
      const effectiveStart = typeof docStart === 'number' && docStart > 0 ? docStart : startLine;
      result.methods.push({
        kind: 'function',
        name,
        range: { startLine: effectiveStart, endLine },
      });
      return;
    }

    if (kind === 'classconstant' || kind === 'constantstatement') {
      const consts = node.constants || [];
      const constNames = consts
        .map((c: any) => (typeof c.name === 'string' ? c.name : c.name?.name || ''))
        .filter(Boolean)
        .join(', ');
      result.constants.push({
        kind: 'constant',
        name: constNames || 'const',
        parentName: currentContainer,
        range: { startLine, endLine },
      });
      return;
    }

    if (kind === 'propertystatement') {
      const propNames = (node.properties || []).map((p: any) => p.name?.name || p.name).join(', ');
      result.properties.push({
        kind: 'property',
        name: propNames,
        parentName: currentContainer,
        range: { startLine, endLine },
      });
      return;
    }

    // Traverse generic children
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        traverse(child, currentContainer);
      }
    }
  }

  traverse(ast);

  return result;
}
