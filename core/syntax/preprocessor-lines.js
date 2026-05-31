const { hasTrailingBackslashContinuation } = require('./continuation');
const { getPreprocessorDirectiveStartIndex } = require('./preprocessor-directive-context');

function isPreprocessorDirectiveLine(line = '') {
    return getPreprocessorDirectiveStartIndex(line) >= 0;
}

function getInactivePreprocessorMaskedLineCandidate(rawLine, preprocessedRawLine) {
    const sourceLine = String(rawLine || '');
    if (!sourceLine.trim()) return '';
    if (String(preprocessedRawLine || '').trim()) return '';
    return sourceLine;
}

function collectPreprocessorDirectiveLineNumbers(lines = []) {
    if (!Array.isArray(lines) || !lines.length) return [];
    const directiveLines = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const source = String(lines[lineIndex] || '');
        if (source.indexOf('#') < 0) continue;
        if (getPreprocessorDirectiveStartIndex(source) >= 0) {
            directiveLines.push(lineIndex);
        }
    }
    return directiveLines;
}

function maskPreprocessorDirectiveLines(source = '') {
    const text = String(source || '');
    if (!text) return text;
    if (text.indexOf('#') < 0) return text;

    const parts = [];
    let cursor = 0;
    let inDirectiveContinuation = false;
    const maskDirectiveLineText = lineText => {
        if (!lineText) return lineText;
        return lineText.indexOf('\r') < 0
            ? ' '.repeat(lineText.length)
            : lineText.replace(/[^\r]/g, ' ');
    };
    while (cursor < text.length) {
        const newlineIndex = text.indexOf('\n', cursor);
        const lineEnd = newlineIndex >= 0 ? newlineIndex : text.length;
        const lineText = text.slice(cursor, lineEnd);
        const shouldMask = inDirectiveContinuation || (
            lineText.indexOf('#') >= 0 &&
            isPreprocessorDirectiveLine(lineText)
        );
        parts.push(shouldMask ? maskDirectiveLineText(lineText) : lineText);
        inDirectiveContinuation = shouldMask && hasTrailingBackslashContinuation(lineText);
        if (newlineIndex < 0) break;
        parts.push('\n');
        cursor = newlineIndex + 1;
    }

    return parts.join('');
}

function isInactivePreprocessorMaskedLine(rawLines = [], preprocessedRawLines = [], lineNumber = -1, options = {}) {
    if (
        !Array.isArray(rawLines) ||
        !Array.isArray(preprocessedRawLines) ||
        rawLines === preprocessedRawLines ||
        !Number.isInteger(lineNumber) ||
        lineNumber < 0 ||
        lineNumber >= rawLines.length ||
        lineNumber >= preprocessedRawLines.length
    ) {
        return false;
    }

    const rawLine = getInactivePreprocessorMaskedLineCandidate(
        rawLines[lineNumber],
        preprocessedRawLines[lineNumber]
    );
    if (!rawLine) return false;

    const isDirectiveLine = typeof options.isPreprocessorDirectiveLineNumber === 'function'
        ? !!options.isPreprocessorDirectiveLineNumber(lineNumber)
        : isPreprocessorDirectiveLine(rawLine);
    return !isDirectiveLine;
}

function buildInactivePreprocessorLineFlags(rawLines = [], preprocessedRawLines = [], lineCount = 0, options = {}) {
    if (!Array.isArray(rawLines) || !Array.isArray(preprocessedRawLines) || rawLines === preprocessedRawLines) {
        return null;
    }

    const flags = new Uint8Array(Math.max(0, lineCount));
    let hasInactiveLine = false;
    const limit = Math.min(flags.length, rawLines.length, preprocessedRawLines.length);
    for (let line = 0; line < limit; line++) {
        const rawLine = getInactivePreprocessorMaskedLineCandidate(
            rawLines[line],
            preprocessedRawLines[line]
        );
        if (!rawLine) continue;
        const isDirectiveLine = typeof options.isPreprocessorDirectiveLineNumber === 'function'
            ? !!options.isPreprocessorDirectiveLineNumber(line)
            : isPreprocessorDirectiveLine(rawLine);
        if (isDirectiveLine) continue;
        flags[line] = 1;
        hasInactiveLine = true;
    }

    return hasInactiveLine ? flags : null;
}

module.exports = {
    collectPreprocessorDirectiveLineNumbers,
    getPreprocessorDirectiveStartIndex,
    isPreprocessorDirectiveLine,
    maskPreprocessorDirectiveLines,
    isInactivePreprocessorMaskedLine,
    buildInactivePreprocessorLineFlags
};
