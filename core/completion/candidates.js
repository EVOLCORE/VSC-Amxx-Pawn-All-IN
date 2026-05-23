function normalizeCompletionCandidateDedupeName(name = '') {
    return String(name || '').replace(/^@+/, '').toLowerCase();
}

function getCompletionCandidateDefaultName(candidate) {
    const data = candidate?.d || {};
    const identity = candidate?.i || {};
    return identity.callInsertName || identity.name || data.name || '';
}

function getCompletionCandidateDedupeKey(candidate, options = {}) {
    const rawName = typeof options.getName === 'function'
        ? options.getName(candidate)
        : getCompletionCandidateDefaultName(candidate);
    const name = normalizeCompletionCandidateDedupeName(rawName);
    return name ? `symbol:${name}` : '';
}

function getCompletionCandidateSourcePriority(candidate) {
    const data = candidate?.d || {};
    const priority = Number.isFinite(candidate?.sourcePriority)
        ? candidate.sourcePriority
        : Number.isFinite(data.sourcePriority)
        ? data.sourcePriority
        : Number.isFinite(data.priority)
        ? data.priority
        : Number.MAX_SAFE_INTEGER;
    return priority;
}

function isCompletionCandidateDeprecated(candidate) {
    return candidate?.d?.deprecated === true || candidate?.deprecated === true;
}

function compareCompletionCandidatePriority(left, leftIndex, right, rightIndex) {
    const leftSort = String(left?.p || '');
    const rightSort = String(right?.p || '');
    if (leftSort !== rightSort) return leftSort < rightSort ? -1 : 1;

    const leftDeprecated = isCompletionCandidateDeprecated(left) ? 1 : 0;
    const rightDeprecated = isCompletionCandidateDeprecated(right) ? 1 : 0;
    if (leftDeprecated !== rightDeprecated) {
        return leftDeprecated < rightDeprecated ? -1 : 1;
    }

    const leftSourcePriority = getCompletionCandidateSourcePriority(left);
    const rightSourcePriority = getCompletionCandidateSourcePriority(right);
    if (leftSourcePriority !== rightSourcePriority) {
        return leftSourcePriority < rightSourcePriority ? -1 : 1;
    }

    return leftIndex - rightIndex;
}

function dedupeCompletionCandidates(candidates, options = {}) {
    if (!Array.isArray(candidates) || candidates.length <= 1) return candidates;

    const bestByKey = new Map();
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        const key = getCompletionCandidateDedupeKey(candidate, options);
        if (!key) continue;
        const previous = bestByKey.get(key);
        if (!previous || compareCompletionCandidatePriority(candidate, index, previous.candidate, previous.index) < 0) {
            bestByKey.set(key, { candidate, index });
        }
    }

    const selectedCandidates = new Set();
    for (const selected of bestByKey.values()) {
        selectedCandidates.add(selected.candidate);
    }
    const emittedSelectedCandidates = new Set();
    const result = [];
    for (const candidate of candidates) {
        if (selectedCandidates.has(candidate)) {
            if (emittedSelectedCandidates.has(candidate)) continue;
            emittedSelectedCandidates.add(candidate);
        } else if (getCompletionCandidateDedupeKey(candidate, options)) {
            continue;
        }
        result.push(candidate);
    }

    return result.length === candidates.length ? candidates : result;
}

module.exports = {
    compareCompletionCandidatePriority,
    dedupeCompletionCandidates,
    getCompletionCandidateDedupeKey,
    getCompletionCandidateSourcePriority,
    isCompletionCandidateDeprecated,
    normalizeCompletionCandidateDedupeName
};
