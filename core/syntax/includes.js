const { readPreprocessorDirectiveNameContext } = require('./preprocessor-directive-context');
const { skipPawnHorizontalWhitespace } = require('./whitespace');

const PAWN_INCLUDE_LINE_RE = /^\s*#\s*(include|tryinclude)\b\s+(?:<([^>"]+)>\s*|"([^"]+)"\s*|([A-Za-z0-9_./\\-]+))/i;
const PAWN_INCLUDE_BARE_CHAR_RE = /[A-Za-z0-9_./\\-]/;

function parsePawnIncludeDirectivePayloadTarget(keyword = '', lineText = '', payloadStart = 0) {
    if (!isIncludeDirectiveKeyword(keyword)) return null;
    const text = String(lineText || '');
    const tokenStart = skipPawnHorizontalWhitespace(text, payloadStart);
    if (tokenStart >= text.length) return null;

    const first = text[tokenStart] || '';
    if (first === '<' || first === '"') {
        const closeChar = first === '<' ? '>' : '"';
        const nameStart = tokenStart + 1;
        const nameEnd = text.indexOf(closeChar, nameStart);
        if (nameEnd < 0) return null;
        const name = text.slice(nameStart, nameEnd);
        if (!name) return null;
        return {
            keyword,
            name,
            nameStart,
            nameEnd,
            tokenStart,
            tokenEnd: Math.min(text.length, nameEnd + 1),
            isDelimited: true,
            delimiter: first === '<' ? '<>' : '""'
        };
    }

    let nameEnd = tokenStart;
    while (nameEnd < text.length && PAWN_INCLUDE_BARE_CHAR_RE.test(text[nameEnd])) {
        nameEnd++;
    }
    const name = text.slice(tokenStart, nameEnd);
    if (!name) return null;

    return {
        keyword,
        name,
        nameStart: tokenStart,
        nameEnd,
        tokenStart,
        tokenEnd: nameEnd,
        isDelimited: false,
        delimiter: ''
    };
}

function parsePawnIncludeDirectiveTarget(lineText = '') {
    const text = String(lineText || '');
    const keywordContext = readIncludeDirectiveKeywordContext(text);
    if (!keywordContext) return null;

    return parsePawnIncludeDirectivePayloadTarget(
        keywordContext.keyword,
        text,
        keywordContext.keywordEnd
    );
}

function getPawnIncludeNameFromLine(lineText = '') {
    return parsePawnIncludeDirectiveTarget(lineText)?.name || '';
}

function isIncludeDirectiveKeyword(keyword = '') {
    const text = String(keyword || '').toLowerCase();
    return text === 'include' || text === 'tryinclude';
}

function readIncludeDirectiveKeywordContext(lineText = '') {
    const context = readPreprocessorDirectiveNameContext(lineText);
    if (!context) return null;
    const keyword = context.directiveName;
    if (!isIncludeDirectiveKeyword(keyword)) return null;
    return {
        hashStart: context.hashStart,
        keyword,
        keywordStart: context.tokenStart,
        keywordEnd: context.tokenEnd
    };
}

function isPawnIncludeDirectiveCandidateLine(lineText = '') {
    return !!readIncludeDirectiveKeywordContext(lineText);
}

function getPawnIncludeCompletionContext(lineText = '', character = 0) {
    const text = String(lineText || '');
    const cursor = Math.max(0, Math.min(text.length, character | 0));
    const keywordContext = readIncludeDirectiveKeywordContext(text);
    if (!keywordContext || cursor <= keywordContext.hashStart || cursor <= keywordContext.keywordEnd) return null;

    const { keyword, keywordEnd } = keywordContext;
    const payloadStart = skipPawnHorizontalWhitespace(text, keywordEnd);
    if (cursor < payloadStart) return null;

    const first = text[payloadStart] || '';
    const buildDelimited = (delimiter, closeChar) => {
        const nameStart = payloadStart + 1;
        const closeIndex = text.indexOf(closeChar, nameStart);
        const hasClosingDelimiter = closeIndex >= 0;
        const nameEnd = hasClosingDelimiter ? closeIndex : cursor;
        if (cursor < nameStart || (hasClosingDelimiter && cursor > closeIndex)) return null;
        return {
            keyword,
            delimiter,
            prefix: text.slice(nameStart, cursor),
            currentName: text.slice(nameStart, Math.max(nameStart, nameEnd)),
            replaceStart: nameStart,
            replaceEnd: Math.max(nameStart, nameEnd),
            needsClosingDelimiter: !hasClosingDelimiter,
            closingDelimiter: closeChar
        };
    };

    if (first === '<') return buildDelimited('<>', '>');
    if (first === '"') return buildDelimited('""', '"');

    let tokenEnd = payloadStart;
    while (tokenEnd < text.length && PAWN_INCLUDE_BARE_CHAR_RE.test(text[tokenEnd])) {
        tokenEnd++;
    }
    if (cursor > tokenEnd) return null;
    return {
        keyword,
        delimiter: '',
        prefix: text.slice(payloadStart, cursor),
        currentName: text.slice(payloadStart, tokenEnd),
        replaceStart: payloadStart,
        replaceEnd: tokenEnd,
        needsClosingDelimiter: false,
        closingDelimiter: ''
    };
}

module.exports = {
    PAWN_INCLUDE_LINE_RE,
    isIncludeDirectiveKeyword,
    isPawnIncludeDirectiveCandidateLine,
    parsePawnIncludeDirectivePayloadTarget,
    parsePawnIncludeDirectiveTarget,
    getPawnIncludeCompletionContext,
    getPawnIncludeNameFromLine
};
