const { hasTrailingBackslashContinuation } = require('./continuation');
const { skipPawnHorizontalWhitespace } = require('./whitespace');

function getPreprocessorDirectiveStartIndex(line = '') {
    const source = String(line || '');
    const index = skipPawnHorizontalWhitespace(source, 0);
    return index < source.length && source.charCodeAt(index) === 35 ? index : -1;
}

function isPreprocessorDirectiveLine(line = '') {
    return getPreprocessorDirectiveStartIndex(line) >= 0;
}

function maskPreprocessorDirectiveLines(source = '') {
    const text = String(source || '');
    if (!text) return text;

    let result = '';
    let cursor = 0;
    let inDirectiveContinuation = false;
    while (cursor < text.length) {
        const newlineIndex = text.indexOf('\n', cursor);
        const lineEnd = newlineIndex >= 0 ? newlineIndex : text.length;
        const lineText = text.slice(cursor, lineEnd);
        const shouldMask = inDirectiveContinuation || isPreprocessorDirectiveLine(lineText);
        result += shouldMask
            ? lineText.replace(/[^\r]/g, ' ')
            : lineText;
        inDirectiveContinuation = shouldMask && hasTrailingBackslashContinuation(lineText);
        if (newlineIndex < 0) break;
        result += '\n';
        cursor = newlineIndex + 1;
    }

    return result;
}

function isInactivePreprocessorMaskedLine(rawLines = [], preprocessedRawLines = [], lineNumber = -1) {
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

    const rawLine = String(rawLines[lineNumber] || '');
    if (!rawLine.trim() || isPreprocessorDirectiveLine(rawLine)) return false;

    return !String(preprocessedRawLines[lineNumber] || '').trim();
}

function buildInactivePreprocessorLineFlags(rawLines = [], preprocessedRawLines = [], lineCount = 0) {
    if (!Array.isArray(rawLines) || !Array.isArray(preprocessedRawLines) || rawLines === preprocessedRawLines) {
        return null;
    }

    const flags = new Uint8Array(Math.max(0, lineCount));
    let hasInactiveLine = false;
    const limit = Math.min(flags.length, rawLines.length, preprocessedRawLines.length);
    for (let line = 0; line < limit; line++) {
        if (!isInactivePreprocessorMaskedLine(rawLines, preprocessedRawLines, line)) continue;
        flags[line] = 1;
        hasInactiveLine = true;
    }

    return hasInactiveLine ? flags : null;
}

module.exports = {
    getPreprocessorDirectiveStartIndex,
    isPreprocessorDirectiveLine,
    maskPreprocessorDirectiveLines,
    isInactivePreprocessorMaskedLine,
    buildInactivePreprocessorLineFlags
};
