const { hasTrailingBackslashContinuation } = require('./continuation');

function findLineNumberAtOffset(lineStartOffsets, offset) {
    const offsets = Array.isArray(lineStartOffsets) ? lineStartOffsets : [];
    if (!offsets.length) return 0;
    const target = Math.max(0, offset | 0);
    let low = 0;
    let high = offsets.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const start = offsets[mid] ?? 0;
        const next = offsets[mid + 1] ?? Number.POSITIVE_INFINITY;
        if (target < start) {
            high = mid - 1;
        } else if (target >= next) {
            low = mid + 1;
        } else {
            return mid;
        }
    }
    return Math.max(0, Math.min(offsets.length - 1, low));
}

function buildLineStartOffsetsFromLines(rawLines) {
    const lines = Array.isArray(rawLines) ? rawLines : [];
    const offsets = [0];
    let offset = 0;
    for (const line of lines) {
        offset += String(line || '').length + 1;
        offsets.push(offset);
    }
    return offsets;
}

function hasUncontinuedPhysicalLineBreakBetweenOffsets(rawLines, lineStartOffsets, startOffset, endOffset) {
    const lines = Array.isArray(rawLines) ? rawLines : [];
    const offsets = Array.isArray(lineStartOffsets) && lineStartOffsets.length
        ? lineStartOffsets
        : buildLineStartOffsetsFromLines(lines);
    const startLine = findLineNumberAtOffset(offsets, startOffset);
    const endLine = findLineNumberAtOffset(offsets, Math.max(startOffset, endOffset));
    if (endLine <= startLine) return false;
    for (let line = startLine; line < endLine; line++) {
        if (!hasTrailingBackslashContinuation(lines[line] || '')) return true;
    }
    return false;
}

module.exports = {
    buildLineStartOffsetsFromLines,
    findLineNumberAtOffset,
    hasUncontinuedPhysicalLineBreakBetweenOffsets
};
