const {
    isPawnIdentifierContinueChar,
    isPawnIdentifierContinueCode,
    isPawnIdentifierStartChar,
    isPawnIdentifierStartCode
} = require('../syntax/identifiers');
const { PAWN_DECLARATION_KEYWORD_SET } = require('../syntax/keywords');
const { countLineBreaks } = require('../syntax/lines');
const { isPreprocessorDirectiveLine } = require('../syntax/preprocessor-lines');
const {
    isPawnWhitespaceCode,
    skipPawnHorizontalWhitespace
} = require('../syntax/whitespace');

function isPotentialEnumDeclarationLine(line) {
    const source = String(line || '');
    const cursor = skipPawnHorizontalWhitespace(source, 0);
    if (source.slice(cursor, cursor + 4) !== 'enum') return false;
    const nextChar = source[cursor + 4] || '';
    return !isPawnIdentifierContinueChar(nextChar);
}

function isPotentialDeclarationStartLine(line) {
    const source = String(line || '');
    const cursor = skipPawnHorizontalWhitespace(source, 0);
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

function readLeadingWord(line) {
    const source = String(line || '');
    let cursor = skipPawnHorizontalWhitespace(source, 0);
    const start = cursor;
    if (!isPawnIdentifierStartChar(source[cursor] || '')) return '';
    cursor++;
    while (cursor < source.length && isPawnIdentifierContinueChar(source[cursor])) cursor++;
    return source.slice(start, cursor);
}

function isExplicitDeclarationStartLine(line) {
    const source = String(line || '');
    if (/^\s*@[A-Za-z_]\w*\s*\(/.test(source)) return true;
    const word = readLeadingWord(line);
    return !!word && PAWN_DECLARATION_KEYWORD_SET.has(word);
}

function isBareDeclarationKeywordLine(line) {
    const text = String(line || '').trim();
    if (!text || /[()[\]{}=,;]/.test(text)) return false;
    const words = text.split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every(word => PAWN_DECLARATION_KEYWORD_SET.has(word));
}

const isWhitespaceCharCode = isPawnWhitespaceCode;

const defaultEscapeRegExp = value =>
    String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function getPawnFunctionNameRegexSource(name, escapeRegExp = defaultEscapeRegExp) {
    const sourceName = String(name || '');
    const escapedName = escapeRegExp(sourceName);
    return `${sourceName.startsWith('@') ? '' : '\\b'}${escapedName}`;
}

function createPawnFunctionCallRegex(name, escapeRegExp = defaultEscapeRegExp) {
    return new RegExp(`${getPawnFunctionNameRegexSource(name, escapeRegExp)}\\s*\\(`);
}

module.exports = {
    countLineBreaks,
    createPawnFunctionCallRegex,
    getPawnFunctionNameRegexSource,
    isBareDeclarationKeywordLine,
    isExplicitDeclarationStartLine,
    isPawnIdentifierContinueCode,
    isPawnIdentifierStartCode,
    isPreprocessorDirectiveLine,
    isPotentialDeclarationStartLine,
    isPotentialEnumDeclarationLine,
    isWhitespaceCharCode,
    readLeadingWord
};
