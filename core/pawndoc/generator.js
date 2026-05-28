function detectLineEnding(text = '') {
    return String(text || '').includes('\r\n') ? '\r\n' : '\n';
}

function splitTextLines(text = '') {
    return String(text || '').split(/\r\n|\n|\r/);
}

function getLineStartOffsets(text = '') {
    const source = String(text || '');
    const offsets = [0];
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (char === '\r') {
            if (source[index + 1] === '\n') index++;
            offsets.push(index + 1);
        } else if (char === '\n') {
            offsets.push(index + 1);
        }
    }
    return offsets;
}

const PAWNDOC_DEFAULT_TARGET_TYPES = new Set(['native', 'forward']);
const PAWNDOC_ANY_FUNCTION_TARGET_TYPES = new Set(['native', 'forward', 'public', 'stock', 'static', 'function']);

function normalizeTargetTypes(targetTypes) {
    if (!targetTypes) return PAWNDOC_DEFAULT_TARGET_TYPES;
    if (targetTypes === 'any-function') return PAWNDOC_ANY_FUNCTION_TARGET_TYPES;
    if (targetTypes instanceof Set) return targetTypes;
    if (Array.isArray(targetTypes)) {
        return new Set(targetTypes.map(type => String(type || '').toLowerCase()).filter(Boolean));
    }
    return PAWNDOC_DEFAULT_TARGET_TYPES;
}

function isPawnDocTargetDeclaration(decl, options = {}) {
    const type = String(decl?.type || '').toLowerCase();
    const targetTypes = normalizeTargetTypes(options.targetTypes);
    return targetTypes.has(type) &&
        !!decl?.name &&
        Number.isInteger(decl.lineNumber) &&
        decl.lineNumber >= 0;
}

function isDeprecatedPragmaLine(line = '') {
    return /^\s*#\s*pragma\s+deprecated\b/i.test(String(line || ''));
}

function isCommentLikeLine(line = '') {
    const text = String(line || '').trim();
    return text.startsWith('//') ||
        text.startsWith('/*') ||
        text.startsWith('*') ||
        text.endsWith('*/');
}

function findPawnDocInsertionLine(lines, declarationLine) {
    let insertionLine = Math.max(0, Math.min(Number(declarationLine) || 0, lines.length));
    let cursor = insertionLine - 1;
    while (cursor >= 0) {
        const text = String(lines[cursor] || '').trim();
        if (!text) {
            cursor--;
            continue;
        }
        if (!isDeprecatedPragmaLine(lines[cursor])) break;
        insertionLine = cursor;
        cursor--;
    }
    return insertionLine;
}

function hasExistingLeadingDocumentation(lines, insertionLine) {
    let cursor = Math.max(-1, Math.min(Number(insertionLine) || 0, lines.length) - 1);
    while (cursor >= 0) {
        const text = String(lines[cursor] || '');
        if (!text.trim()) {
            return false;
        }
        return isCommentLikeLine(text);
    }
    return false;
}

function findFirstNonEmptyLine(lines, startLine, endLine = startLine) {
    const fromLine = Math.max(0, Number(startLine) || 0);
    const toLine = Math.max(fromLine, Math.min(lines.length - 1, Number(endLine) || fromLine));
    for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber++) {
        if (String(lines[lineNumber] || '').trim()) return lineNumber;
    }
    return -1;
}

function getPawnDocDeclarationLineRange(decl) {
    const startLine = Number.isInteger(decl?.startLine) ? decl.startLine : decl?.lineNumber;
    const endLine = Number.isInteger(decl?.headerEndLine) ? decl.headerEndLine : startLine;
    return {
        startLine: Number.isInteger(startLine) ? startLine : -1,
        endLine: Number.isInteger(endLine) ? endLine : Number.isInteger(startLine) ? startLine : -1
    };
}

function findPawnDocDeclarationForLine(declarations, lineNumber, options = {}) {
    const targetLine = Number(lineNumber);
    if (!Number.isInteger(targetLine) || targetLine < 0) return null;
    const candidates = [];
    for (const decl of Array.isArray(declarations) ? declarations : []) {
        if (!isPawnDocTargetDeclaration(decl, options)) continue;
        const { startLine, endLine } = getPawnDocDeclarationLineRange(decl);
        if (startLine < 0 || endLine < startLine) continue;
        if (targetLine < startLine || targetLine > endLine) continue;
        candidates.push({ decl, startLine, endLine });
    }
    candidates.sort((left, right) => {
        const leftSpan = left.endLine - left.startLine;
        const rightSpan = right.endLine - right.startLine;
        return leftSpan - rightSpan || left.startLine - right.startLine;
    });
    return candidates[0]?.decl || null;
}

function stripTopLevelDefaultValue(text = '') {
    const source = String(text || '');
    let depth = 0;
    let inString = false;
    let stringQuote = '';
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (inString) {
            if (char === stringQuote) inString = false;
            continue;
        }
        if (char === '"' || char === "'") {
            inString = true;
            stringQuote = char;
            continue;
        }
        if ('([{'.includes(char)) {
            depth++;
            continue;
        }
        if (')]}'.includes(char)) {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (char === '=' && depth === 0) {
            return source.slice(0, index).trim();
        }
    }
    return source.trim();
}

function fallbackExtractParamName(paramText = '') {
    let text = stripTopLevelDefaultValue(paramText)
        .replace(/;$/, '')
        .trim();
    if (!text || text === '...' || /\.\.\./.test(text)) return '';
    while (/^(const|static|stock)\b/i.test(text)) {
        text = text.replace(/^(const|static|stock)\b/i, '').trimStart();
    }
    while (text.startsWith('&')) {
        text = text.slice(1).trimStart();
    }
    while (/^[A-Za-z_][A-Za-z0-9_]*\s*:\s*/.test(text)) {
        text = text.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*:\s*/, '').trimStart();
    }
    const match = text.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[\s\S]*\])?\s*$/);
    return match ? match[1] : '';
}

function extractPawnDocParamNames(decl, options = {}) {
    const names = [];
    const pushName = name => {
        const normalized = String(name || '').trim();
        if (normalized && !names.includes(normalized)) names.push(normalized);
    };

    if (typeof options.parseFuncArgs === 'function') {
        try {
            const parsedArgs = options.parseFuncArgs(
                decl.args || '',
                decl.filePath || '',
                decl.file || '',
                decl.lineNumber || 0,
                options.escapeChar
            );
            if (Array.isArray(parsedArgs) && parsedArgs.length) {
                for (const arg of parsedArgs) pushName(arg?.name);
                return names;
            }
        } catch {
            // Fall back to the light parser below. PawnDoc generation should not
            // fail just because semantic arg parsing could not handle a prototype.
        }
    }

    const splitTopLevel = typeof options.splitTopLevel === 'function'
        ? options.splitTopLevel
        : source => String(source || '').split(',');
    for (const piece of splitTopLevel(String(decl.args || ''), options.escapeChar, false)) {
        pushName(fallbackExtractParamName(piece));
    }
    return names;
}

function generatePawnDocBlock(decl, options = {}) {
    const eol = options.eol || '\n';
    const indent = String(options.indent || '');
    const paramNames = extractPawnDocParamNames(decl, options);
    const includeReturn = options.includeReturn !== false;
    const lines = [
        `${indent}/**`,
        `${indent} *`,
        `${indent} *`
    ];
    for (const name of paramNames) {
        lines.push(`${indent} * @param ${name}`);
    }
    if (includeReturn) {
        lines.push(`${indent} *`);
        lines.push(`${indent} * @return`);
    }
    lines.push(`${indent} */`);
    return lines.join(eol);
}

function buildPawnDocInsertionPlan(text, declarations, options = {}) {
    const source = String(text || '');
    const eol = options.eol || detectLineEnding(source);
    const lines = Array.isArray(options.lines) ? options.lines : splitTextLines(source);
    const offsets = getLineStartOffsets(source);
    const insertions = [];
    const occupiedLines = new Set();

    for (const decl of Array.isArray(declarations) ? declarations : []) {
        if (!isPawnDocTargetDeclaration(decl)) continue;
        if (decl.lineNumber >= lines.length) continue;
        if (String(decl.docs || '').trim()) continue;
        const declarationLine = decl.lineNumber;
        const insertionLine = findPawnDocInsertionLine(lines, declarationLine);
        if (occupiedLines.has(insertionLine)) continue;
        if (hasExistingLeadingDocumentation(lines, insertionLine)) continue;

        const sourceLine = String(lines[declarationLine] || '');
        const indent = (sourceLine.match(/^\s*/) || [''])[0];
        const block = generatePawnDocBlock(decl, {
            ...options,
            eol,
            indent
        });
        insertions.push({
            line: insertionLine,
            offset: offsets[insertionLine] ?? source.length,
            text: `${block}${eol}`,
            decl
        });
        occupiedLines.add(insertionLine);
    }

    return {
        eol,
        insertions
    };
}

function buildPawnDocSingleInsertionPlan(text, declarations, selection = {}, options = {}) {
    const source = String(text || '');
    const eol = options.eol || detectLineEnding(source);
    const lines = Array.isArray(options.lines) ? options.lines : splitTextLines(source);
    const offsets = getLineStartOffsets(source);
    const startLine = Number.isInteger(selection?.startLine) ? selection.startLine : Number(selection?.startLine) || 0;
    const endLine = Number.isInteger(selection?.endLine) ? selection.endLine : startLine;
    const targetLine = findFirstNonEmptyLine(lines, startLine, endLine);
    const insertions = [];
    if (targetLine < 0) return { eol, insertions };

    const decl = findPawnDocDeclarationForLine(declarations, targetLine, {
        targetTypes: options.targetTypes || 'any-function'
    });
    const isDeclarationDoc = !!decl && !String(decl.docs || '').trim();
    const insertionLine = isDeclarationDoc
        ? findPawnDocInsertionLine(lines, decl.lineNumber)
        : targetLine;

    if (hasExistingLeadingDocumentation(lines, insertionLine)) {
        return { eol, insertions };
    }

    const sourceLine = String(lines[isDeclarationDoc ? decl.lineNumber : targetLine] || '');
    const indent = (sourceLine.match(/^\s*/) || [''])[0];
    const block = generatePawnDocBlock(
        isDeclarationDoc
            ? decl
            : { type: 'selection', name: '', args: '', lineNumber: targetLine, docs: '' },
        {
            ...options,
            eol,
            indent,
            includeReturn: isDeclarationDoc
        }
    );

    insertions.push({
        line: insertionLine,
        offset: offsets[insertionLine] ?? source.length,
        text: `${block}${eol}`,
        decl: isDeclarationDoc ? decl : null
    });

    return {
        eol,
        insertions
    };
}

module.exports = {
    buildPawnDocInsertionPlan,
    buildPawnDocSingleInsertionPlan,
    detectLineEnding,
    extractPawnDocParamNames,
    fallbackExtractParamName,
    findPawnDocDeclarationForLine,
    findPawnDocInsertionLine,
    generatePawnDocBlock,
    hasExistingLeadingDocumentation,
    isPawnDocTargetDeclaration,
    splitTextLines
};
