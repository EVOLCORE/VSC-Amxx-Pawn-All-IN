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

function isPawnDocTargetDeclaration(decl) {
    const type = String(decl?.type || '').toLowerCase();
    return (type === 'native' || type === 'forward') &&
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
    let skippedBlankLine = false;
    while (cursor >= 0) {
        const text = String(lines[cursor] || '');
        if (!text.trim()) {
            if (skippedBlankLine) return false;
            skippedBlankLine = true;
            cursor--;
            continue;
        }
        return isCommentLikeLine(text);
    }
    return false;
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
    const lines = [
        `${indent}/**`,
        `${indent} *`,
        `${indent} *`
    ];
    for (const name of paramNames) {
        lines.push(`${indent} * @param ${name}`);
    }
    lines.push(`${indent} *`);
    lines.push(`${indent} * @return`);
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

module.exports = {
    buildPawnDocInsertionPlan,
    detectLineEnding,
    extractPawnDocParamNames,
    fallbackExtractParamName,
    findPawnDocInsertionLine,
    generatePawnDocBlock,
    hasExistingLeadingDocumentation,
    isPawnDocTargetDeclaration,
    splitTextLines
};
