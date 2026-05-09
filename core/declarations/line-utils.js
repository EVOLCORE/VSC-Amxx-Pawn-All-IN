function isPotentialEnumDeclarationLine(line) {
    const source = String(line || '');
    let cursor = 0;
    while (cursor < source.length) {
        const code = source.charCodeAt(cursor);
        if (code !== 32 && code !== 9) break;
        cursor++;
    }
    if (source.slice(cursor, cursor + 4) !== 'enum') return false;
    const nextChar = source[cursor + 4] || '';
    return !/[A-Za-z0-9_@]/.test(nextChar);
}

function isPotentialDeclarationStartLine(line) {
    const source = String(line || '');
    let cursor = 0;
    while (cursor < source.length) {
        const code = source.charCodeAt(cursor);
        if (code !== 32 && code !== 9) break;
        cursor++;
    }
    if (cursor >= source.length) return false;

    const code = source.charCodeAt(cursor);
    if (
        code === 35 ||  // #
        code === 41 ||  // )
        code === 44 ||  // ,
        code === 59 ||  // ;
        code === 93 ||  // ]
        code === 125    // }
    ) {
        return false;
    }
    if (code === 47 || code === 42) return false; // / or * comment leftovers
    return (
        code === 95 ||  // _
        code === 64 ||  // @
        code === 123 || // {tag}:
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122)
    );
}

const explicitDeclarationStartKeywords = new Set([
    'new',
    'static',
    'stock',
    'public',
    'private',
    'const',
    'native',
    'forward',
    'enum'
]);

function readLeadingWord(line) {
    const source = String(line || '');
    let cursor = 0;
    while (cursor < source.length) {
        const code = source.charCodeAt(cursor);
        if (code !== 32 && code !== 9) break;
        cursor++;
    }
    const start = cursor;
    if (!/[A-Za-z_@]/.test(source[cursor] || '')) return '';
    cursor++;
    while (cursor < source.length && /[A-Za-z0-9_@]/.test(source[cursor])) cursor++;
    return source.slice(start, cursor);
}

function isExplicitDeclarationStartLine(line) {
    const word = readLeadingWord(line);
    return !!word && explicitDeclarationStartKeywords.has(word);
}

const isWhitespaceCharCode = code =>
    code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13;

const isPawnIdentifierStartCode = code =>
    code === 95 ||
    code === 64 ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122);

const isPawnIdentifierContinueCode = code =>
    isPawnIdentifierStartCode(code) ||
    (code >= 48 && code <= 57);

function countLineBreaks(source, start = 0, end = source.length) {
    let count = 0;
    for (let index = Math.max(0, start); index < end && index < source.length; index++) {
        if (source[index] === '\n') count++;
    }
    return count;
}

module.exports = {
    countLineBreaks,
    isExplicitDeclarationStartLine,
    isPawnIdentifierContinueCode,
    isPawnIdentifierStartCode,
    isPotentialDeclarationStartLine,
    isPotentialEnumDeclarationLine,
    isWhitespaceCharCode,
    readLeadingWord
};
