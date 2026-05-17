const { findBalancedGroupEnd } = require('./balanced');

function getLineText(lines, lineNumber, options = {}) {
    if (typeof options.getLineText === 'function') {
        return String(options.getLineText(lineNumber) || '');
    }
    return String((Array.isArray(lines) ? lines[lineNumber] : '') || '');
}

function findNextNonEmptyLine(lines, startLine, options = {}) {
    const sourceLines = Array.isArray(lines) ? lines : [];
    const fallback = Number.isInteger(options.fallback) ? options.fallback : -1;
    for (let lineNumber = Math.max(0, startLine); lineNumber < sourceLines.length; lineNumber++) {
        if (getLineText(sourceLines, lineNumber, options).trim()) return lineNumber;
    }
    return fallback;
}

function findPreviousNonEmptyLine(lines, startLine, options = {}) {
    const sourceLines = Array.isArray(lines) ? lines : [];
    const fallback = Number.isInteger(options.fallback) ? options.fallback : -1;
    for (let lineNumber = Math.min(startLine, sourceLines.length - 1); lineNumber >= 0; lineNumber--) {
        if (getLineText(sourceLines, lineNumber, options).trim()) return lineNumber;
    }
    return fallback;
}

function isWhileConditionOnlyLine(trimmedLine) {
    const source = String(trimmedLine || '').trim();
    if (!/^while\b/.test(source)) return false;
    const openIndex = source.indexOf('(');
    if (openIndex < 0) return false;
    const closeIndex = findBalancedGroupEnd(source, openIndex, '(', ')');
    if (closeIndex < 0) return false;
    return /^;?$/.test(source.slice(closeIndex + 1).trim());
}

function startsCompilerMultilineContinuation(trimmedLine) {
    const source = String(trimmedLine || '').trim();
    return /^[)\]},]/.test(source) ||
        /^(?:&&|\|\||[+\-*/%&|^<>=!?:,])/.test(source);
}

function continuesCompilerMultilineToNextLine(trimmedLine) {
    const source = String(trimmedLine || '').trim();
    return /(?:&&|\|\||[+\-*/%&|^<>=!?:,[({])\s*$/.test(source);
}

function areCompilerMultilineLinesConnected(previousTrimmed, currentTrimmed) {
    return startsCompilerMultilineContinuation(currentTrimmed) ||
        continuesCompilerMultilineToNextLine(previousTrimmed);
}

function getCompilerLineDepth(lineNumber, options = {}) {
    return typeof options.getLineDepth === 'function'
        ? options.getLineDepth(lineNumber)
        : null;
}

function getCompilerTrimmedLine(lines, lineNumber, options = {}) {
    return getLineText(lines, lineNumber, options).trim();
}

function isCompilerIgnoredLine(trimmedLine, options = {}) {
    return typeof options.isIgnoredLine === 'function'
        ? !!options.isIgnoredLine(trimmedLine)
        : !String(trimmedLine || '').trim();
}

function isCompilerLineDepthCompatible(lineNumber, baseDepth, options = {}) {
    const depth = getCompilerLineDepth(lineNumber, options);
    return depth == null || baseDepth == null || depth === baseDepth;
}

function getCompilerMultilineStatementRange(lines, lineNumber, options = {}) {
    const sourceLines = Array.isArray(lines) ? lines : [];
    if (!Number.isInteger(lineNumber) || lineNumber < 0 || lineNumber >= sourceLines.length) return null;

    const startLimit = Number.isInteger(options.startLine) ? Math.max(0, options.startLine) : 0;
    const endLimit = Number.isInteger(options.endLine)
        ? Math.min(sourceLines.length - 1, options.endLine)
        : sourceLines.length - 1;
    if (lineNumber < startLimit || lineNumber > endLimit) return null;

    const baseDepth = options.baseDepth ?? getCompilerLineDepth(lineNumber, options);
    const startTrimmed = getCompilerTrimmedLine(sourceLines, lineNumber, options);
    if (isCompilerIgnoredLine(startTrimmed, options)) return null;
    if (!isCompilerLineDepthCompatible(lineNumber, baseDepth, options)) return null;

    let startLine = lineNumber;
    while (startLine > startLimit) {
        const previousLine = findPreviousNonEmptyLine(sourceLines, startLine - 1, options);
        if (previousLine < startLimit) break;
        const previousTrimmed = getCompilerTrimmedLine(sourceLines, previousLine, options);
        const currentTrimmed = getCompilerTrimmedLine(sourceLines, startLine, options);
        if (isCompilerIgnoredLine(previousTrimmed, options)) break;
        if (!isCompilerLineDepthCompatible(previousLine, baseDepth, options)) break;
        if (!areCompilerMultilineLinesConnected(previousTrimmed, currentTrimmed)) break;
        startLine = previousLine;
    }

    let endLine = lineNumber;
    while (endLine < endLimit) {
        const nextLine = findNextNonEmptyLine(sourceLines, endLine + 1, options);
        if (nextLine < 0 || nextLine > endLimit) break;
        const currentTrimmed = getCompilerTrimmedLine(sourceLines, endLine, options);
        const nextTrimmed = getCompilerTrimmedLine(sourceLines, nextLine, options);
        if (isCompilerIgnoredLine(nextTrimmed, options)) break;
        if (!isCompilerLineDepthCompatible(nextLine, baseDepth, options)) break;
        if (!areCompilerMultilineLinesConnected(currentTrimmed, nextTrimmed)) break;
        endLine = nextLine;
    }

    const text = [];
    for (let line = startLine; line <= endLine; line++) {
        const trimmed = getCompilerTrimmedLine(sourceLines, line, options);
        if (!isCompilerIgnoredLine(trimmed, options)) text.push(trimmed);
    }

    return {
        startLine,
        endLine,
        text: text.join(' ').trim()
    };
}

function isCompilerMultilineContinuationLine(lines, lineNumber, options = {}) {
    const range = getCompilerMultilineStatementRange(lines, lineNumber, options);
    return !!range && range.startLine < lineNumber;
}

function isDoWhileClosingLine(lines, depths, lineNumber, options = {}) {
    const sourceLines = Array.isArray(lines) ? lines : [];
    const trimmedLine = getLineText(sourceLines, lineNumber, options).trim();
    if (!isWhileConditionOnlyLine(trimmedLine)) return false;

    const previousLine = findPreviousNonEmptyLine(sourceLines, lineNumber - 1, options);
    if (previousLine < 0) return false;
    const previousTrimmed = getLineText(sourceLines, previousLine, options).trim();
    if (!previousTrimmed.startsWith('}') && !/}\s*$/.test(previousTrimmed)) return false;

    if (!Array.isArray(depths)) return true;
    const baseDepth = depths[lineNumber] ?? 0;
    for (let probe = previousLine; probe >= 0; probe--) {
        if ((depths[probe] ?? 0) !== baseDepth) continue;
        const probeLine = getLineText(sourceLines, probe, options);
        const openBraceIndex = probeLine.indexOf('{');
        if (openBraceIndex < 0) continue;

        const beforeBrace = probeLine.slice(0, openBraceIndex).trim();
        if (/^do\b/.test(beforeBrace)) return true;

        const doLine = findPreviousNonEmptyLine(sourceLines, probe - 1, options);
        return doLine >= 0 && /^do\b/.test(getLineText(sourceLines, doLine, options).trim());
    }

    return false;
}

module.exports = {
    areCompilerMultilineLinesConnected,
    continuesCompilerMultilineToNextLine,
    findNextNonEmptyLine,
    findPreviousNonEmptyLine,
    getCompilerMultilineStatementRange,
    isDoWhileClosingLine,
    isCompilerMultilineContinuationLine,
    isWhileConditionOnlyLine,
    startsCompilerMultilineContinuation
};
