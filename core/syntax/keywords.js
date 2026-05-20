const {
    isPawnIdentifierBoundaryChar,
    isPawnIdentifierContinueCode,
    isPawnIdentifierStartCode
} = require('./identifiers');

const PAWN_DECLARATION_KEYWORDS = Object.freeze([
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

const PAWN_LOCAL_DECLARATION_KEYWORDS = Object.freeze([
    'new',
    'static',
    'const',
    'enum'
]);

const PAWN_CONTROL_KEYWORDS = Object.freeze([
    'if',
    'for',
    'while',
    'switch',
    'return',
    'case',
    'default',
    'else',
    'do'
]);

const PAWN_BLOCK_CONTROL_KEYWORDS = Object.freeze([
    'for',
    'if',
    'else',
    'while',
    'do',
    'switch'
]);

const PAWN_FLOW_KEYWORDS = Object.freeze([
    ...PAWN_CONTROL_KEYWORDS,
    'break',
    'continue',
    'state',
    'goto',
    'assert',
    'sleep',
    'exit'
]);

const PAWN_DECLARATION_OR_CONTROL_KEYWORDS = Object.freeze([
    ...PAWN_DECLARATION_KEYWORDS,
    ...PAWN_CONTROL_KEYWORDS,
    'state',
    'goto',
    'assert',
    'sleep',
    'exit'
]);

const PAWN_STRUCTURAL_KEYWORDS = Object.freeze([
    ...PAWN_FLOW_KEYWORDS,
    ...PAWN_DECLARATION_KEYWORDS
]);

const PAWN_NON_FUNCTION_HEADER_KEYWORDS = Object.freeze([
    ...PAWN_FLOW_KEYWORDS,
    'sizeof',
    'defined',
    'enum',
    'new',
    'const'
]);

const PAWN_NON_FUNCTION_NAME_KEYWORDS = Object.freeze([
    'if',
    'for',
    'while',
    'switch',
    'sizeof',
    'defined'
]);

const escapeRegExp = value =>
    String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function createPawnKeywordRegex(keywords = [], flags = '') {
    const source = Array.from(keywords || [])
        .filter(Boolean)
        .map(escapeRegExp)
        .join('|');
    return new RegExp(`\\b(?:${source || '$^'})\\b`, flags);
}

const PAWN_LOCAL_DECLARATION_KEYWORD_RE = createPawnKeywordRegex(PAWN_LOCAL_DECLARATION_KEYWORDS);
const PAWN_STRUCTURAL_KEYWORD_RE = createPawnKeywordRegex(PAWN_STRUCTURAL_KEYWORDS);
const PAWN_NON_FUNCTION_HEADER_KEYWORD_RE = createPawnKeywordRegex(PAWN_NON_FUNCTION_HEADER_KEYWORDS, 'i');
const PAWN_NON_FUNCTION_NAME_KEYWORD_RE = createPawnKeywordRegex(PAWN_NON_FUNCTION_NAME_KEYWORDS, 'i');

const PAWN_DECLARATION_KEYWORD_SET = new Set(PAWN_DECLARATION_KEYWORDS);
const PAWN_LOCAL_DECLARATION_KEYWORD_SET = new Set(PAWN_LOCAL_DECLARATION_KEYWORDS);
const PAWN_CONTROL_KEYWORD_SET = new Set(PAWN_CONTROL_KEYWORDS);
const PAWN_BLOCK_CONTROL_KEYWORD_SET = new Set(PAWN_BLOCK_CONTROL_KEYWORDS);
const PAWN_FLOW_KEYWORD_SET = new Set(PAWN_FLOW_KEYWORDS);
const PAWN_DECLARATION_OR_CONTROL_KEYWORD_SET = new Set(PAWN_DECLARATION_OR_CONTROL_KEYWORDS);
const PAWN_STRUCTURAL_KEYWORD_SET = new Set(PAWN_STRUCTURAL_KEYWORDS);
const PAWN_NON_FUNCTION_HEADER_KEYWORD_SET = new Set(PAWN_NON_FUNCTION_HEADER_KEYWORDS);
const PAWN_NON_FUNCTION_NAME_KEYWORD_SET = new Set(PAWN_NON_FUNCTION_NAME_KEYWORDS);
const keywordSetCache = new WeakMap();

function getKeywordSetForList(keywords = [], options = {}) {
    if (keywords instanceof Set) return keywords;
    if (!Array.isArray(keywords)) return new Set();
    const caseInsensitive = options.caseInsensitive === true;
    let cached = keywordSetCache.get(keywords);
    if (!cached) {
        cached = { exact: new Set(keywords), lower: null };
        keywordSetCache.set(keywords, cached);
    }
    if (!caseInsensitive) return cached.exact;
    if (!cached.lower) {
        cached.lower = new Set(keywords.map(keyword => String(keyword || '').toLowerCase()));
    }
    return cached.lower;
}

function readKeywordCandidateAt(source = '', startIndex = 0) {
    const text = String(source || '');
    const start = Math.max(0, startIndex | 0);
    if (start >= text.length || !isPawnIdentifierStartCode(text.charCodeAt(start))) return '';
    let end = start + 1;
    while (end < text.length && isPawnIdentifierContinueCode(text.charCodeAt(end))) end++;
    return text.slice(start, end);
}

function startsWithPawnKeyword(source = '', startIndex = 0, keyword = '', options = {}) {
    const text = String(source || '');
    const word = String(keyword || '');
    if (!word) return false;
    const start = Math.max(0, startIndex | 0);
    const actual = text.slice(start, start + word.length);
    const matched = options.caseInsensitive
        ? actual.toLowerCase() === word.toLowerCase()
        : actual === word;
    return matched && isPawnIdentifierBoundaryChar(text[start + word.length] || '');
}

function startsWithAnyPawnKeyword(source = '', startIndex = 0, keywords = [], options = {}) {
    const candidate = readKeywordCandidateAt(source, startIndex);
    if (!candidate) return false;
    const lookupName = options.caseInsensitive ? candidate.toLowerCase() : candidate;
    return getKeywordSetForList(keywords, options).has(lookupName);
}

function startsWithDeclarationKeyword(source = '', startIndex = 0, options = {}) {
    return startsWithAnyPawnKeyword(source, startIndex, PAWN_DECLARATION_KEYWORDS, options);
}

function startsWithLocalDeclarationKeyword(source = '', startIndex = 0, options = {}) {
    return startsWithAnyPawnKeyword(source, startIndex, PAWN_LOCAL_DECLARATION_KEYWORDS, options);
}

function startsWithControlKeyword(source = '', startIndex = 0, options = {}) {
    return startsWithAnyPawnKeyword(source, startIndex, PAWN_CONTROL_KEYWORDS, options);
}

function startsWithBlockControlKeyword(source = '', startIndex = 0, options = {}) {
    return startsWithAnyPawnKeyword(source, startIndex, PAWN_BLOCK_CONTROL_KEYWORDS, options);
}

function startsWithDeclarationOrControlKeyword(source = '', startIndex = 0, options = {}) {
    return startsWithAnyPawnKeyword(source, startIndex, PAWN_DECLARATION_OR_CONTROL_KEYWORDS, options);
}

function containsPawnKeyword(source = '', keyword = '', options = {}) {
    const text = String(source || '');
    const word = String(keyword || '');
    if (!word) return false;
    const haystack = options.caseInsensitive ? text.toLowerCase() : text;
    const needle = options.caseInsensitive ? word.toLowerCase() : word;
    let index = haystack.indexOf(needle);
    while (index >= 0) {
        const before = text[index - 1] || '';
        const after = text[index + word.length] || '';
        if (isPawnIdentifierBoundaryChar(before) && isPawnIdentifierBoundaryChar(after)) return true;
        index = haystack.indexOf(needle, index + word.length);
    }
    return false;
}

function containsAnyPawnKeyword(source = '', keywords = [], options = {}) {
    for (const keyword of keywords || []) {
        if (containsPawnKeyword(source, keyword, options)) return true;
    }
    return false;
}

function isPawnKeywordName(source = '', keywordSet = PAWN_DECLARATION_OR_CONTROL_KEYWORD_SET, options = {}) {
    const text = String(source || '');
    if (!text) return false;
    if (options.caseInsensitive) {
        return keywordSet.has(text.toLowerCase());
    }
    return keywordSet.has(text);
}

module.exports = {
    createPawnKeywordRegex,
    containsAnyPawnKeyword,
    containsPawnKeyword,
    isPawnKeywordName,
    PAWN_BLOCK_CONTROL_KEYWORDS,
    PAWN_BLOCK_CONTROL_KEYWORD_SET,
    PAWN_CONTROL_KEYWORDS,
    PAWN_CONTROL_KEYWORD_SET,
    PAWN_DECLARATION_KEYWORDS,
    PAWN_DECLARATION_OR_CONTROL_KEYWORDS,
    PAWN_DECLARATION_OR_CONTROL_KEYWORD_SET,
    PAWN_DECLARATION_KEYWORD_SET,
    PAWN_FLOW_KEYWORDS,
    PAWN_FLOW_KEYWORD_SET,
    PAWN_LOCAL_DECLARATION_KEYWORDS,
    PAWN_LOCAL_DECLARATION_KEYWORD_RE,
    PAWN_LOCAL_DECLARATION_KEYWORD_SET,
    PAWN_NON_FUNCTION_HEADER_KEYWORDS,
    PAWN_NON_FUNCTION_HEADER_KEYWORD_RE,
    PAWN_NON_FUNCTION_HEADER_KEYWORD_SET,
    PAWN_NON_FUNCTION_NAME_KEYWORDS,
    PAWN_NON_FUNCTION_NAME_KEYWORD_RE,
    PAWN_NON_FUNCTION_NAME_KEYWORD_SET,
    PAWN_STRUCTURAL_KEYWORDS,
    PAWN_STRUCTURAL_KEYWORD_RE,
    PAWN_STRUCTURAL_KEYWORD_SET,
    startsWithAnyPawnKeyword,
    startsWithBlockControlKeyword,
    startsWithControlKeyword,
    startsWithDeclarationKeyword,
    startsWithDeclarationOrControlKeyword,
    startsWithLocalDeclarationKeyword,
    startsWithPawnKeyword
};
