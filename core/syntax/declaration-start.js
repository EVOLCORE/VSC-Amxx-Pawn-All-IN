const {
    isPawnIdentifierContinueCode,
    isPawnIdentifierStartCode
} = require('./identifiers');
const {
    PAWN_DECLARATION_KEYWORD_SET,
    startsWithDeclarationKeyword
} = require('./keywords');

function skipDeclarationHorizontalWhitespace(source, index = 0) {
    let cursor = Math.max(0, index | 0);
    while (cursor < source.length) {
        const code = source.charCodeAt(cursor);
        if (code !== 32 && code !== 9) break;
        cursor++;
    }
    return cursor;
}

function isPotentialEnumDeclarationLine(line) {
    const source = String(line || '');
    const cursor = skipDeclarationHorizontalWhitespace(source, 0);
    if (!source.startsWith('enum', cursor)) return false;
    return !isPawnIdentifierContinueCode(source.charCodeAt(cursor + 4));
}

function isPotentialDeclarationStartLine(line) {
    const source = String(line || '');
    const cursor = skipDeclarationHorizontalWhitespace(source, 0);
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
        code === 123 || // {tag}:
        isPawnIdentifierStartCode(code)
    );
}

function readLeadingDeclarationWord(line) {
    const source = String(line || '');
    let cursor = skipDeclarationHorizontalWhitespace(source, 0);
    const start = cursor;
    if (!isPawnIdentifierStartCode(source.charCodeAt(cursor))) return '';
    cursor++;
    while (cursor < source.length && isPawnIdentifierContinueCode(source.charCodeAt(cursor))) cursor++;
    return source.slice(start, cursor);
}

function isAtPublicFunctionStartLine(line) {
    const source = String(line || '');
    const cursor = skipDeclarationHorizontalWhitespace(source, 0);
    if (source.charCodeAt(cursor) !== 64) return false; // @
    const nameStart = cursor + 1;
    if (!isPawnIdentifierStartCode(source.charCodeAt(nameStart))) return false;
    let nameEnd = nameStart + 1;
    while (nameEnd < source.length && isPawnIdentifierContinueCode(source.charCodeAt(nameEnd))) nameEnd++;
    const parenStart = skipDeclarationHorizontalWhitespace(source, nameEnd);
    return source.charCodeAt(parenStart) === 40; // (
}

function isExplicitDeclarationStartLine(line) {
    const source = String(line || '');
    if (isAtPublicFunctionStartLine(source)) return true;
    const cursor = skipDeclarationHorizontalWhitespace(source, 0);
    return startsWithDeclarationKeyword(source, cursor);
}

function isBareDeclarationKeywordLine(line) {
    const text = String(line || '').trim();
    if (!text) return false;
    let cursor = 0;
    let sawKeyword = false;
    while (cursor < text.length) {
        while (cursor < text.length && text.charCodeAt(cursor) <= 32) cursor++;
        const start = cursor;
        while (cursor < text.length && text.charCodeAt(cursor) > 32) {
            const code = text.charCodeAt(cursor);
            if (
                code === 40 || // (
                code === 41 || // )
                code === 44 || // ,
                code === 59 || // ;
                code === 61 || // =
                code === 91 || // [
                code === 93 || // ]
                code === 123 || // {
                code === 125    // }
            ) {
                return false;
            }
            cursor++;
        }
        if (start === cursor) break;
        if (!PAWN_DECLARATION_KEYWORD_SET.has(text.slice(start, cursor))) return false;
        sawKeyword = true;
    }
    return sawKeyword;
}

module.exports = {
    isAtPublicFunctionStartLine,
    isBareDeclarationKeywordLine,
    isExplicitDeclarationStartLine,
    isPawnIdentifierContinueCode,
    isPawnIdentifierStartCode,
    isPotentialDeclarationStartLine,
    isPotentialEnumDeclarationLine,
    readLeadingDeclarationWord
};
