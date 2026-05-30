function splitPawnLines(source = '') {
    const text = String(source || '');
    if (text.indexOf('\n') < 0) return [text];
    if (text.indexOf('\r') < 0) return text.split('\n');
    const lines = [];
    let lineStart = 0;
    let lineBreak = text.indexOf('\n', lineStart);
    while (lineBreak >= 0) {
        const lineEnd = lineBreak > lineStart && text.charCodeAt(lineBreak - 1) === 13
            ? lineBreak - 1
            : lineBreak;
        lines.push(text.slice(lineStart, lineEnd));
        lineStart = lineBreak + 1;
        lineBreak = text.indexOf('\n', lineStart);
    }
    lines.push(text.slice(lineStart));
    return lines;
}

function countLineBreaks(source = '', start = 0, end = String(source || '').length) {
    const text = String(source || '');
    const safeStart = Math.max(0, start | 0);
    const safeEnd = Math.min(text.length, Math.max(safeStart, end | 0));
    let count = 0;
    let lineBreak = text.indexOf('\n', safeStart);
    while (lineBreak >= 0 && lineBreak < safeEnd) {
        count++;
        lineBreak = text.indexOf('\n', lineBreak + 1);
    }
    return count;
}

function countTextLines(source = '') {
    return countLineBreaks(source) + 1;
}

function buildLineStartOffsets(source = '') {
    const text = String(source || '');
    const offsets = [0];
    let lineBreak = text.indexOf('\n');
    while (lineBreak >= 0) {
        offsets.push(lineBreak + 1);
        lineBreak = text.indexOf('\n', lineBreak + 1);
    }
    return offsets;
}

function resolveLineStartOffset(lineStartOffsets, lineNumber, fallback = 0) {
    const offset = Array.isArray(lineStartOffsets) ? lineStartOffsets[lineNumber] : undefined;
    if (Number.isFinite(offset)) return offset;
    return typeof fallback === 'function' ? fallback(lineNumber) : fallback;
}

module.exports = {
    buildLineStartOffsets,
    countLineBreaks,
    countTextLines,
    resolveLineStartOffset,
    splitPawnLines
};
