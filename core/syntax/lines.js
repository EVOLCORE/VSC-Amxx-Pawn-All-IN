function splitPawnLines(source = '') {
    const text = String(source || '');
    const lines = [];
    let lineStart = 0;
    for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) !== 10) continue;
        const lineEnd = index > lineStart && text.charCodeAt(index - 1) === 13
            ? index - 1
            : index;
        lines.push(text.slice(lineStart, lineEnd));
        lineStart = index + 1;
    }
    lines.push(text.slice(lineStart));
    return lines;
}

function countLineBreaks(source = '', start = 0, end = String(source || '').length) {
    const text = String(source || '');
    const safeStart = Math.max(0, start | 0);
    const safeEnd = Math.min(text.length, Math.max(safeStart, end | 0));
    let count = 0;
    for (let index = safeStart; index < safeEnd; index++) {
        if (text.charCodeAt(index) === 10) count++;
    }
    return count;
}

function countTextLines(source = '') {
    return countLineBreaks(source) + 1;
}

module.exports = {
    countLineBreaks,
    countTextLines,
    splitPawnLines
};
