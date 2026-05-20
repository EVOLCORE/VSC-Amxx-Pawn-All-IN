const DEFAULT_MIN_FUZZY_PREFIX_LENGTH = 3;

function normalizeCompletionMatchText(value) {
    return String(value || '').toLowerCase();
}

function padMatchNumber(value, width) {
    const safeValue = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    return String(safeValue).padStart(width, '0');
}

function makeCompletionMatch(kind, rank, firstIndex, span, gaps, textLength) {
    return {
        kind,
        rank,
        firstIndex,
        span,
        gaps,
        textLength,
        sortKey: [
            padMatchNumber(rank, 2),
            padMatchNumber(firstIndex, 5),
            padMatchNumber(gaps, 5),
            padMatchNumber(span, 5),
            padMatchNumber(textLength, 5)
        ].join('_')
    };
}

function getFuzzySubsequenceStats(text, prefix) {
    if (!text || !prefix) return null;
    let textIndex = 0;
    let firstIndex = -1;
    let previousIndex = -1;
    let gaps = 0;

    for (let prefixIndex = 0; prefixIndex < prefix.length; prefixIndex++) {
        const char = prefix[prefixIndex];
        const foundIndex = text.indexOf(char, textIndex);
        if (foundIndex < 0) return null;
        if (firstIndex < 0) {
            firstIndex = foundIndex;
        } else if (previousIndex >= 0) {
            gaps += Math.max(0, foundIndex - previousIndex - 1);
        }
        previousIndex = foundIndex;
        textIndex = foundIndex + 1;
    }

    return {
        firstIndex,
        span: Math.max(0, previousIndex - firstIndex + 1),
        gaps
    };
}

function getCompletionMatch(text, prefix, options = {}) {
    const normalizedText = normalizeCompletionMatchText(text);
    const normalizedPrefix = normalizeCompletionMatchText(prefix);
    if (!normalizedPrefix) {
        return makeCompletionMatch('all', 4, 0, 0, 0, normalizedText.length);
    }
    if (!normalizedText) return null;

    if (normalizedText === normalizedPrefix) {
        return makeCompletionMatch('exact', 0, 0, normalizedPrefix.length, 0, normalizedText.length);
    }
    if (normalizedText.startsWith(normalizedPrefix)) {
        return makeCompletionMatch('startsWith', 1, 0, normalizedPrefix.length, 0, normalizedText.length);
    }

    const containsIndex = normalizedText.indexOf(normalizedPrefix);
    if (containsIndex >= 0) {
        return makeCompletionMatch(
            'contains',
            2,
            containsIndex,
            normalizedPrefix.length,
            containsIndex,
            normalizedText.length
        );
    }

    const minFuzzyPrefixLength = Number.isInteger(options.minFuzzyPrefixLength)
        ? Math.max(1, options.minFuzzyPrefixLength)
        : DEFAULT_MIN_FUZZY_PREFIX_LENGTH;
    if (normalizedPrefix.length < minFuzzyPrefixLength) return null;

    const fuzzy = getFuzzySubsequenceStats(normalizedText, normalizedPrefix);
    if (!fuzzy) return null;
    return makeCompletionMatch(
        'fuzzy',
        3,
        fuzzy.firstIndex,
        fuzzy.span,
        fuzzy.gaps,
        normalizedText.length
    );
}

function compareCompletionMatches(left, right) {
    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;
    return String(left.sortKey || '').localeCompare(String(right.sortKey || ''));
}

function getBestCompletionMatch(texts, prefix, options = {}) {
    const values = Array.isArray(texts) ? texts : [texts];
    let best = null;
    for (const value of values) {
        const match = getCompletionMatch(value, prefix, options);
        if (!match) continue;
        if (!best || compareCompletionMatches(match, best) < 0) {
            best = match;
        }
    }
    return best;
}

function withCompletionMatchSortPrefix(sortPrefix, match) {
    const prefix = String(sortPrefix || '');
    if (!match?.sortKey) return prefix;
    return prefix ? `${prefix}_${match.sortKey}` : match.sortKey;
}

module.exports = {
    DEFAULT_MIN_FUZZY_PREFIX_LENGTH,
    compareCompletionMatches,
    getBestCompletionMatch,
    getCompletionMatch,
    normalizeCompletionMatchText,
    withCompletionMatchSortPrefix
};
