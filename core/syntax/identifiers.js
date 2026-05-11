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
    const text = String(source || '');
    for (let index = 0; index < text.length; index++) {
        if (isPawnIdentifierStartCode(text.charCodeAt(index))) return true;
    }
    return false;
}

function readPawnIdentifierAt(source = '', index = 0, options = {}) {
    const text = String(source || '');
    const start = Math.max(0, Number.isInteger(index) ? index : 0);
    const isIdentifierStartChar = typeof options.isIdentifierStartChar === 'function'
        ? options.isIdentifierStartChar
        : isPawnIdentifierStartChar;
    const isIdentifierContinueChar = typeof options.isIdentifierContinueChar === 'function'
        ? options.isIdentifierContinueChar
        : isPawnIdentifierContinueChar;
    if (!isIdentifierStartChar(text[start] || '')) return null;

    let end = start + 1;
    while (end < text.length && isIdentifierContinueChar(text[end] || '')) end++;

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

function isPawnIdentifierName(value = '') {
    const text = String(value || '');
    const identifier = readPawnIdentifierAt(text, 0);
    return !!identifier && identifier.end === text.length;
}

function getPawnIdentifierName(value = '') {
    const text = String(value || '').trim();
    return isPawnIdentifierName(text) ? text : '';
}

module.exports = {
    containsPawnIdentifierStartChar,
    getPawnIdentifierName,
    isPawnIdentifierBoundaryChar,
    isPawnIdentifierContinueChar,
    isPawnIdentifierContinueCode,
    isPawnIdentifierName,
    isPawnIdentifierStartChar,
    isPawnIdentifierStartCode,
    readPawnIdentifierAt
};
