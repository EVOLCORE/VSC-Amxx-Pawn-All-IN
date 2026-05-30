const { PAWN_IDENTIFIER_SOURCE } = require('../syntax/identifiers');

const DECLARATION_KEYWORD_RE = /^(?:new|static|const|public|stock|native|forward)\b/i;
const DECLARATION_MACRO_PREFIX_RE = new RegExp(
    `^(?:(?:const|static)\\s+)*(?:(?:${PAWN_IDENTIFIER_SOURCE}|_)\\s*:\\s*)?$`,
    'i'
);

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getMacroParamTokens(args) {
    const text = String(args || '');
    const tokens = [];
    const seen = new Set();
    const re = /%[A-Za-z0-9_]+/g;
    let match;
    while ((match = re.exec(text))) {
        const token = match[0];
        if (seen.has(token)) continue;
        seen.add(token);
        tokens.push(token);
    }
    return tokens;
}

function hasOnlyDeclaratorSuffix(value) {
    const text = String(value || '').trim();
    if (!text) return true;
    let index = 0;
    while (index < text.length) {
        if (text[index] !== '[') return false;
        const closeIndex = text.indexOf(']', index + 1);
        if (closeIndex < 0) return true;
        index = closeIndex + 1;
        while (index < text.length && /\s/.test(text[index])) index++;
    }
    return true;
}

function isDeclarationMacroPrefix(value) {
    const text = String(value || '').trim();
    if (DECLARATION_KEYWORD_RE.test(text)) return false;
    return DECLARATION_MACRO_PREFIX_RE.test(text);
}

function isDeclarationLikeFunctionDefineDecl(decl) {
    if (!decl || decl.type !== 'define' || decl.macroStyle !== 'paren') return false;
    const value = String(decl.value || '').trim();
    if (!value || DECLARATION_KEYWORD_RE.test(value)) return false;

    const params = getMacroParamTokens(decl.args);
    if (!params.length) return false;

    for (const param of params) {
        const re = new RegExp(escapeRegExp(param), 'g');
        let match;
        while ((match = re.exec(value))) {
            const before = value.slice(0, match.index);
            const after = value.slice(match.index + param.length);
            if (
                isDeclarationMacroPrefix(before) &&
                hasOnlyDeclaratorSuffix(after)
            ) {
                return true;
            }
        }
    }
    return false;
}

module.exports = {
    isDeclarationLikeFunctionDefineDecl
};
