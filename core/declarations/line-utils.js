const {
    isPawnIdentifierContinueCode,
    isBareDeclarationKeywordLine,
    isExplicitDeclarationStartLine,
    isPawnIdentifierStartCode,
    isPotentialDeclarationStartLine,
    isPotentialEnumDeclarationLine,
    isVariableDeclarationContinuationLine,
    readLeadingDeclarationWord
} = require('../syntax/declaration-start');
const { countLineBreaks } = require('../syntax/lines');
const { isPreprocessorDirectiveLine } = require('../syntax/preprocessor-lines');
const { isPawnWhitespaceCode } = require('../syntax/whitespace');

const readLeadingWord = readLeadingDeclarationWord;

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
    isVariableDeclarationContinuationLine,
    isWhitespaceCharCode,
    readLeadingWord
};
