const { countTextLines } = require('../syntax/lines');

function normalizeEditImpactLineRange(range, lineCount = 0) {
    const safeLineCount = Number.isFinite(lineCount)
        ? Math.max(0, Math.floor(lineCount))
        : 0;
    if (!safeLineCount) return null;
    const startLine = Math.max(0, range?.startLine ?? 0);
    const endLine = Math.min(
        safeLineCount - 1,
        Math.max(startLine, range?.endLine ?? startLine)
    );
    if (endLine < startLine) return null;
    return { startLine, endLine };
}

function getContentChangeStartLine(change, fallback = null) {
    const lineNumber = change?.range?.start?.line;
    return Number.isInteger(lineNumber) ? lineNumber : fallback;
}

function getContentChangeEndLine(change, fallback = null) {
    const lineNumber = change?.range?.end?.line;
    return Number.isInteger(lineNumber) ? lineNumber : fallback;
}

function getContentChangeStartCharacter(change, fallback = 0) {
    const character = change?.range?.start?.character;
    return Number.isInteger(character) ? character : fallback;
}

function normalizeContentChangeLineRange(change, options = {}) {
    const {
        lineCount = 0,
        paddingBefore = 0,
        paddingAfter = 0,
        includeInsertedLineBreaks = false,
        fallbackLine = 0
    } = options;
    const startBase = getContentChangeStartLine(change, fallbackLine);
    if (!Number.isInteger(startBase)) return null;
    const start = Math.max(0, startBase);
    const end = Math.max(start, getContentChangeEndLine(change, start) ?? start);
    const insertedLineSpan = countTextLines(change?.text || '');
    const insertedLineBreaks = Math.max(0, insertedLineSpan - 1);
    const replacedLineSpan = Math.max(1, end - start + 1);
    const logicalEnd = includeInsertedLineBreaks
        ? Math.max(start, end + insertedLineBreaks)
        : end;
    const safeLineCount = Number.isFinite(lineCount)
        ? Math.max(0, Math.floor(lineCount))
        : 0;
    const startLine = Math.max(0, start - Math.max(0, paddingBefore | 0));
    const unclampedEndLine = Math.max(
        startLine,
        logicalEnd + Math.max(0, paddingAfter | 0)
    );
    const endLine = safeLineCount > 0
        ? Math.min(safeLineCount - 1, unclampedEndLine)
        : unclampedEndLine;
    return {
        startLine,
        endLine,
        rangeStartLine: start,
        rangeEndLine: end,
        insertedLineBreaks,
        insertedLineSpan,
        replacedLineSpan
    };
}

function collectContentChangeLineSet(document, contentChanges = [], options = {}) {
    const lines = new Set();
    const lineCount = Number.isInteger(document?.lineCount) ? document.lineCount : 0;
    for (const change of contentChanges || []) {
        const range = normalizeContentChangeLineRange(change, {
            lineCount,
            ...options
        });
        if (!range) continue;
        for (let line = range.startLine; line <= range.endLine; line++) {
            lines.add(line);
        }
    }
    return lines;
}

function compareContentChangesByStartDescending(left, right) {
    const rightLine = getContentChangeStartLine(right, 0) ?? 0;
    const leftLine = getContentChangeStartLine(left, 0) ?? 0;
    if (rightLine !== leftLine) return rightLine - leftLine;
    return getContentChangeStartCharacter(right, 0) - getContentChangeStartCharacter(left, 0);
}

function getFirstContentChangeStartLine(contentChanges = []) {
    for (const change of contentChanges || []) {
        const lineNumber = getContentChangeStartLine(change, null);
        if (Number.isInteger(lineNumber)) return lineNumber;
    }
    return null;
}

function contentChangesCrossLineBoundary(contentChanges = []) {
    let firstStartLine = null;
    for (const change of contentChanges || []) {
        const text = String(change?.text || '');
        if (/[\r\n]/.test(text)) return true;
        const startLine = getContentChangeStartLine(change, null);
        const endLine = getContentChangeEndLine(change, null);
        if (Number.isInteger(startLine)) {
            if (firstStartLine == null) {
                firstStartLine = startLine;
            } else if (firstStartLine !== startLine) {
                return true;
            }
        }
        if (Number.isInteger(startLine) && Number.isInteger(endLine) && startLine !== endLine) {
            return true;
        }
    }
    return false;
}

function forEachEditImpactLine(editImpact, lineCount = 0, callback = null) {
    if (typeof callback !== 'function') return;
    for (const range of editImpact?.ranges || []) {
        const normalizedRange = normalizeEditImpactLineRange(range, lineCount);
        if (!normalizedRange) continue;
        for (let lineNumber = normalizedRange.startLine; lineNumber <= normalizedRange.endLine; lineNumber++) {
            callback(lineNumber, range, normalizedRange);
        }
    }
}

function collectEditImpactLineSet(editImpact, lineCount = 0) {
    const lines = new Set();
    forEachEditImpactLine(editImpact, lineCount, lineNumber => lines.add(lineNumber));
    return lines;
}

function patchChangedLineArray(targetLines = [], sourceLines = [], editImpact = null, options = {}) {
    const {
        lineCount = sourceLines.length,
        readLine = null
    } = options;
    forEachEditImpactLine(editImpact, lineCount, lineNumber => {
        targetLines[lineNumber] = typeof readLine === 'function'
            ? readLine(lineNumber, sourceLines)
            : sourceLines[lineNumber];
    });
    return targetLines;
}

module.exports = {
    collectContentChangeLineSet,
    collectEditImpactLineSet,
    compareContentChangesByStartDescending,
    contentChangesCrossLineBoundary,
    forEachEditImpactLine,
    getContentChangeEndLine,
    getContentChangeStartLine,
    getContentChangeStartCharacter,
    getFirstContentChangeStartLine,
    normalizeContentChangeLineRange,
    normalizeEditImpactLineRange,
    patchChangedLineArray
};
