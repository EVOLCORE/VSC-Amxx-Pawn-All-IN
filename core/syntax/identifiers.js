const PAWN_IDENTIFIER_SOURCE = '[A-Za-z_@][A-Za-z0-9_@]*';
const PAWN_IDENTIFIER_RE = new RegExp(PAWN_IDENTIFIER_SOURCE);
const PAWN_IDENTIFIER_NAME_RE = new RegExp(`^${PAWN_IDENTIFIER_SOURCE}$`);

const isPawnIdentifierStartCode = code =>
    code === 95 ||
    code === 64 ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122);

const isPawnIdentifierContinueCode = code =>
    isPawnIdentifierStartCode(code) ||
    (code >= 48 && code <= 57);

const isPawnIdentifierStartChar = (char = '') =>
    !!char && isPawnIdentifierStartCode(String(char).charCodeAt(0));

const isPawnIdentifierContinueChar = (char = '') =>
    !!char && isPawnIdentifierContinueCode(String(char).charCodeAt(0));

const isPawnIdentifierBoundaryChar = (char = '') =>
    !char || !isPawnIdentifierContinueChar(char);

function containsPawnIdentifierStartChar(source = '') {
    const text = typeof source === 'string' ? source : String(source || '');
    for (let index = 0; index < text.length; index++) {
        if (isPawnIdentifierStartCode(text.charCodeAt(index))) return true;
    }
    return false;
}

function readPawnIdentifierAt(source = '', index = 0, options = null) {
    const text = typeof source === 'string' ? source : String(source || '');
    const start = typeof index === 'number' && index > 0 ? index | 0 : 0;
    const customStart = options && typeof options.isIdentifierStartChar === 'function'
        ? options.isIdentifierStartChar
        : null;
    const customContinue = options && typeof options.isIdentifierContinueChar === 'function'
        ? options.isIdentifierContinueChar
        : null;
    let end = start + 1;
    if (!customStart && !customContinue) {
        if (start >= text.length || !isPawnIdentifierStartCode(text.charCodeAt(start))) return null;
        while (end < text.length && isPawnIdentifierContinueCode(text.charCodeAt(end))) end++;
    } else {
        const isIdentifierStartChar = customStart || isPawnIdentifierStartChar;
        const isIdentifierContinueChar = customContinue || isPawnIdentifierContinueChar;
        if (!isIdentifierStartChar(text[start] || '')) return null;
        while (end < text.length && isIdentifierContinueChar(text[end] || '')) end++;
    }

    const name = text.slice(start, end);
    return {
        type: 'identifier',
        name,
        text: name,
        value: name,
        start,
        end
    };
}

function createPawnIdentifierReader(options = {}) {
    const isIdentifierStartChar = typeof options.isIdentifierStartChar === 'function'
        ? options.isIdentifierStartChar
        : null;
    const isIdentifierContinueChar = typeof options.isIdentifierContinueChar === 'function'
        ? options.isIdentifierContinueChar
        : null;
    const usesDefaultStart = !isIdentifierStartChar || isIdentifierStartChar === isPawnIdentifierStartChar;
    const usesDefaultContinue = !isIdentifierContinueChar || isIdentifierContinueChar === isPawnIdentifierContinueChar;
    if (usesDefaultStart && usesDefaultContinue) {
        return readPawnIdentifierAt;
    }
    const canStart = isIdentifierStartChar || isPawnIdentifierStartChar;
    const canContinue = isIdentifierContinueChar || isPawnIdentifierContinueChar;
    return (source = '', index = 0) => {
        const text = typeof source === 'string' ? source : String(source || '');
        const start = typeof index === 'number' && index > 0 ? index | 0 : 0;
        if (!canStart(text[start] || '')) return null;
        let end = start + 1;
        while (end < text.length && canContinue(text[end] || '')) end++;
        const name = text.slice(start, end);
        return {
            type: 'identifier',
            name,
            text: name,
            value: name,
            start,
            end
        };
    };
}

function isPawnIdentifierName(value = '') {
    const text = typeof value === 'string' ? value : String(value || '');
    if (!text || !isPawnIdentifierStartCode(text.charCodeAt(0))) return false;
    for (let index = 1; index < text.length; index++) {
        if (!isPawnIdentifierContinueCode(text.charCodeAt(index))) return false;
    }
    return true;
}

function getPawnIdentifierName(value = '') {
    const text = (typeof value === 'string' ? value : String(value || '')).trim();
    return isPawnIdentifierName(text) ? text : '';
}

module.exports = {
    PAWN_IDENTIFIER_NAME_RE,
    PAWN_IDENTIFIER_RE,
    PAWN_IDENTIFIER_SOURCE,
    containsPawnIdentifierStartChar,
    createPawnIdentifierReader,
    getPawnIdentifierName,
    isPawnIdentifierBoundaryChar,
    isPawnIdentifierContinueChar,
    isPawnIdentifierContinueCode,
    isPawnIdentifierName,
    isPawnIdentifierStartChar,
    isPawnIdentifierStartCode,
    readPawnIdentifierAt
};
