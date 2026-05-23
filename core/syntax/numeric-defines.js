const { PAWN_IDENTIFIER_SOURCE } = require('./identifiers');

const PAWN_IDENTIFIER_RE = new RegExp(PAWN_IDENTIFIER_SOURCE, 'g');
const NUMERIC_DEFINE_LITERAL_RE = /^-?(?:0[xX][0-9A-Fa-f]+|\d+\.\d+(?:[eE][+-]?\d+)?|\d+)\b$/;
const NUMERIC_LITERAL_TOKEN_RE = /0[xX][0-9A-Fa-f]+|\d+\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?/g;
const NUMERIC_DEFINE_EXPR_RE = /^[0+\-*/%|&^~<>().\s]+$/;

function normalizeDefineValue(value) {
    return String(value || '').trim();
}

function isNumericDefineValue(value) {
    const text = normalizeDefineValue(value);
    if (NUMERIC_DEFINE_LITERAL_RE.test(text)) return true;
    const normalized = text.replace(NUMERIC_LITERAL_TOKEN_RE, '0');
    return normalized !== text && NUMERIC_DEFINE_EXPR_RE.test(normalized);
}

function isNumericObjectLikeDefineDecl(decl) {
    return !!decl &&
        decl.type === 'define' &&
        !decl.args &&
        !decl.macroStyle &&
        isNumericDefineValue(decl.value);
}

function collectNumericDefineNamesFromContext(ctx) {
    const byName = new Map();
    const pushDecls = decls => {
        for (const decl of decls || []) {
            if (!decl || decl.type !== 'define' || decl.args || decl.macroStyle || !decl.name) continue;
            byName.set(String(decl.name), isNumericObjectLikeDefineDecl(decl));
        }
    };

    const hasStructuredDecls = Array.isArray(ctx?.incDecls) || Array.isArray(ctx?.parsedDecls?.globals);
    if (hasStructuredDecls) {
        pushDecls(ctx?.incDecls);
        pushDecls(ctx?.parsedDecls?.globals);
    } else {
        pushDecls(ctx?.allDecls);
    }

    const names = new Set();
    for (const [name, numeric] of byName) {
        if (numeric) names.add(name);
    }
    return names;
}

function findNumericDefineNameRangesInLine(lineText, numericDefineNames) {
    if (!numericDefineNames || numericDefineNames.size === 0) return [];

    const source = String(lineText || '');
    const ranges = [];
    PAWN_IDENTIFIER_RE.lastIndex = 0;

    let match;
    while ((match = PAWN_IDENTIFIER_RE.exec(source))) {
        const name = match[0];
        if (!numericDefineNames.has(name)) continue;
        ranges.push({
            name,
            start: match.index,
            end: match.index + name.length
        });
    }
    return ranges;
}

module.exports = {
    collectNumericDefineNamesFromContext,
    findNumericDefineNameRangesInLine,
    isNumericDefineValue,
    isNumericObjectLikeDefineDecl
};
