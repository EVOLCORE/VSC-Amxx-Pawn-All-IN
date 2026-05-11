const FIXED_PAWN_TAG_NAMES = new Set(['float', 'bool', 'string']);

function normalizePawnTagName(value = '') {
    return String(value || '').replace(/^_?\s*:\s*/, '').trim();
}

function normalizeDeclaredPawnTagName(value = '') {
    const withoutTrailingColon = String(value || '').trim().replace(/:$/, '').trim();
    const normalized = normalizePawnTagName(withoutTrailingColon);
    if (!normalized || normalized === '_' || normalized.toLowerCase() === 'any') return '';
    return normalized;
}

function isAnyPawnTagName(value = '') {
    return normalizePawnTagName(value).toLowerCase() === 'any';
}

function isFixedPawnTagName(value = '') {
    return FIXED_PAWN_TAG_NAMES.has(normalizePawnTagName(value).toLowerCase());
}

module.exports = {
    FIXED_PAWN_TAG_NAMES,
    isAnyPawnTagName,
    isFixedPawnTagName,
    normalizeDeclaredPawnTagName,
    normalizePawnTagName
};
