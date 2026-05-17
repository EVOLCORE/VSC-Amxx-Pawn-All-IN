const { getPreprocessorDirectiveStartIndex } = require('./preprocessor-lines');
const {
    isPawnHorizontalWhitespaceCode,
    skipPawnHorizontalWhitespace
} = require('./whitespace');

const PAWN_INCLUDE_LINE_RE = /^\s*#\s*(include|tryinclude)\b\s+(?:<([^>"]+)>\s*|"([^"]+)"\s*|([A-Za-z0-9_./\\-]+))/i;
const PAWN_INCLUDE_BARE_CHAR_RE = /[A-Za-z0-9_./\\-]/;

function parsePawnIncludeDirectiveTarget(lineText = '') {
    const text = String(lineText || '');
    const match = text.match(PAWN_INCLUDE_LINE_RE);
    if (!match) return null;

    const keyword = String(match[1] || '').toLowerCase();
    const angleName = match[2] || '';
    const quotedName = match[3] || '';
    const bareName = match[4] || '';
    const name = angleName || quotedName || bareName;
    if (!name) return null;

    const matchedText = match[0] || '';
    const nameStartInMatch = matchedText.lastIndexOf(name);
    if (nameStartInMatch < 0) return null;

    const nameStart = (match.index || 0) + nameStartInMatch;
    const nameEnd = nameStart + name.length;
    const isDelimited = !!(angleName || quotedName);

    return {
        keyword,
        name,
        nameStart,
        nameEnd,
        tokenStart: isDelimited ? Math.max(0, nameStart - 1) : nameStart,
        tokenEnd: isDelimited ? Math.min(text.length, nameEnd + 1) : nameEnd,
        isDelimited,
        delimiter: angleName ? '<>' : (quotedName ? '""' : '')
    };
}

function getPawnIncludeNameFromLine(lineText = '') {
    return parsePawnIncludeDirectiveTarget(lineText)?.name || '';
}

function isIncludeDirectiveKeyword(keyword = '') {
    const text = String(keyword || '').toLowerCase();
    return text === 'include' || text === 'tryinclude';
}

function getPawnIncludeCompletionContext(lineText = '', character = 0) {
    const text = String(lineText || '');
    const cursor = Math.max(0, Math.min(text.length, character | 0));
    const hashStart = getPreprocessorDirectiveStartIndex(text);
    if (hashStart < 0 || cursor <= hashStart) return null;

    let keywordStart = hashStart + 1;
    while (
        keywordStart < text.length &&
        isPawnHorizontalWhitespaceCode(text.charCodeAt(keywordStart))
    ) {
        keywordStart++;
    }

    let keywordEnd = keywordStart;
    while (keywordEnd < text.length && /[A-Za-z0-9_]/.test(text[keywordEnd])) {
        keywordEnd++;
    }

    const keyword = text.slice(keywordStart, keywordEnd).toLowerCase();
    if (!isIncludeDirectiveKeyword(keyword) || cursor <= keywordEnd) return null;

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
    parsePawnIncludeDirectiveTarget,
    getPawnIncludeCompletionContext,
    getPawnIncludeNameFromLine
};
