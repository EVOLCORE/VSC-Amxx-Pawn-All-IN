const isPawnWhitespaceCode = code =>
    code === 32 ||
    code === 9 ||
    code === 10 ||
    code === 11 ||
    code === 12 ||
    code === 13;

const isPawnHorizontalWhitespaceCode = code =>
    code === 32 ||
    code === 9;

const isPawnWhitespaceChar = (char = '') => {
    if (!char) return false;
    const text = typeof char === 'string' ? char : String(char);
    const code = text.charCodeAt(0);
    return isPawnWhitespaceCode(code) || (code > 127 && /\s/.test(text[0] || ''));
};

const isPawnHorizontalWhitespaceChar = (char = '') =>
    !!char && isPawnHorizontalWhitespaceCode((typeof char === 'string' ? char : String(char)).charCodeAt(0));

function skipPawnWhitespace(source, index = 0) {
    const text = String(source || '');
    let cursor = Math.max(0, index | 0);
    while (cursor < text.length && isPawnWhitespaceChar(text[cursor])) cursor++;
    return cursor;
}

function skipPawnHorizontalWhitespace(source, index = 0) {
    const text = String(source || '');
    let cursor = Math.max(0, index | 0);
    while (cursor < text.length && isPawnHorizontalWhitespaceCode(text.charCodeAt(cursor))) cursor++;
    return cursor;
}

function findPawnLineTrimEndIndex(source, startIndex = 0, options = {}) {
    const text = String(source || '');
    let cursor = text.length;
    const allowCarriageReturn = !!options.allowCarriageReturn;
    while (cursor > Math.max(0, startIndex | 0)) {
        const code = text.charCodeAt(cursor - 1);
        if (
            code !== 32 &&
            code !== 9 &&
            !(allowCarriageReturn && code === 13)
        ) {
            break;
        }
        cursor--;
    }
    return cursor;
}

function getPawnLineTrimBounds(source, options = {}) {
    const text = String(source || '');
    const start = skipPawnHorizontalWhitespace(text, 0);
    const end = findPawnLineTrimEndIndex(text, start, options);
    return { start, end };
}

function findNextNonWhitespaceIndex(source, index = 0) {
    const text = String(source || '');
    for (let cursor = Math.max(0, index | 0); cursor < text.length; cursor++) {
        if (!isPawnWhitespaceChar(text[cursor])) return cursor;
    }
    return -1;
}

function findPreviousNonWhitespaceIndex(source, index = 0) {
    const text = String(source || '');
    for (let cursor = Math.min(text.length - 1, index | 0); cursor >= 0; cursor--) {
        if (!isPawnWhitespaceChar(text[cursor])) return cursor;
    }
    return -1;
}

module.exports = {
    findPawnLineTrimEndIndex,
    findNextNonWhitespaceIndex,
    findPreviousNonWhitespaceIndex,
    getPawnLineTrimBounds,
    isPawnHorizontalWhitespaceChar,
    isPawnHorizontalWhitespaceCode,
    isPawnWhitespaceChar,
    isPawnWhitespaceCode,
    skipPawnHorizontalWhitespace,
    skipPawnWhitespace
};
