function getHoverMatchKey(match, getDeclMatchKey, options = {}) {
    if (!match?.data || typeof getDeclMatchKey !== 'function') return '';

    const declKey = getDeclMatchKey(match.data);
    if (!declKey) return '';

    return options.includeLabel
        ? `${declKey}|${match.label || ''}`
        : declKey;
}

function dedupeHoverMatches(matches, getDeclMatchKey, options = {}) {
    if (!Array.isArray(matches) || !matches.length) return [];

    const seen = new Set();
    const unique = [];
    for (const match of matches) {
        if (!match?.data) continue;

        const key = getHoverMatchKey(match, getDeclMatchKey, options);
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        unique.push(match);
    }
    return unique;
}

function hasHoverMatch(matches, match, getDeclMatchKey, options = {}) {
    if (!Array.isArray(matches) || !match?.data) return false;

    const key = getHoverMatchKey(match, getDeclMatchKey, options);
    if (!key) return false;

    return matches.some(item =>
        item?.data &&
        getHoverMatchKey(item, getDeclMatchKey, options) === key
    );
}

function pushUniqueHoverMatch(matches, match, getDeclMatchKey, options = {}) {
    if (!Array.isArray(matches) || !match?.data) return false;
    if (hasHoverMatch(matches, match, getDeclMatchKey, options)) return false;

    matches.push(match);
    return true;
}

module.exports = {
    dedupeHoverMatches,
    getHoverMatchKey,
    hasHoverMatch,
    pushUniqueHoverMatch
};
