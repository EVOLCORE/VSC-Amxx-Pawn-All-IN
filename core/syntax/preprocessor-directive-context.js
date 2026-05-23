const {
    isPawnIdentifierContinueCode,
    isPawnIdentifierStartCode
} = require('./identifiers');
const {
    isPawnHorizontalWhitespaceCode,
    skipPawnHorizontalWhitespace
} = require('./whitespace');

function normalizePreprocessorDirectiveName(value = '') {
    const text = String(value || '');
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code >= 65 && code <= 90) return text.toLowerCase();
    }
    return text;
}

function getPreprocessorDirectiveStartIndex(line = '') {
    const source = String(line || '');
    const index = skipPawnHorizontalWhitespace(source, 0);
    return index < source.length && source.charCodeAt(index) === 35 ? index : -1;
}

function skipPreprocessorIdentifierWhitespace(source = '', cursor = 0) {
    const text = String(source || '');
    let index = Math.max(0, cursor | 0);
    while (
        index < text.length &&
        isPawnHorizontalWhitespaceCode(text.charCodeAt(index))
    ) {
        index++;
    }
    return index;
}

function readPreprocessorIdentifierToken(source = '', cursor = 0) {
    const text = String(source || '');
    const start = skipPreprocessorIdentifierWhitespace(text, cursor);
    if (start >= text.length || !isPawnIdentifierStartCode(text.charCodeAt(start))) return null;
    let end = start + 1;
    while (end < text.length && isPawnIdentifierContinueCode(text.charCodeAt(end))) end++;
    return {
        name: text.slice(start, end),
        start,
        end
    };
}

function readPreprocessorDirectiveNameContext(line = '') {
    const source = String(line || '');
    const hashStart = skipPawnHorizontalWhitespace(source, 0);
    if (hashStart >= source.length || source.charCodeAt(hashStart) !== 35) return null;

    const tokenStart = skipPreprocessorIdentifierWhitespace(source, hashStart + 1);
    let tokenEnd = tokenStart;
    if (tokenStart < source.length && isPawnIdentifierStartCode(source.charCodeAt(tokenStart))) {
        tokenEnd = tokenStart + 1;
        while (tokenEnd < source.length && isPawnIdentifierContinueCode(source.charCodeAt(tokenEnd))) tokenEnd++;
    }
    const directiveNameRaw = tokenEnd > tokenStart
        ? source.slice(tokenStart, tokenEnd)
        : '';

    return {
        hashStart,
        tokenStart,
        tokenEnd,
        directiveNameRaw,
        directiveName: normalizePreprocessorDirectiveName(directiveNameRaw)
    };
}

function isPreprocessorDirectiveNamedLine(line = '', directiveName = '') {
    const expected = normalizePreprocessorDirectiveName(directiveName);
    return !!expected && readPreprocessorDirectiveNameContext(line)?.directiveName === expected;
}

module.exports = {
    getPreprocessorDirectiveStartIndex,
    isPreprocessorDirectiveNamedLine,
    normalizePreprocessorDirectiveName,
    readPreprocessorDirectiveNameContext,
    readPreprocessorIdentifierToken,
    skipPreprocessorIdentifierWhitespace
};
