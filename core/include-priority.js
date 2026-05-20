const INCLUDE_RESOLUTION_PRIORITY = Object.freeze({
    local: 0,
    ancestorLocal: 100,
    ancestorHint: 200,
    configured: 1000,
    discovered: 2000
});

const DEFAULT_INCLUDE_SOURCE_PRIORITY = Number.MAX_SAFE_INTEGER;

function normalizeIncludePriority(value, fallback = DEFAULT_INCLUDE_SOURCE_PRIORITY) {
    return Number.isFinite(value) ? value : fallback;
}

function getIncludeCandidateSourcePriority(candidate = {}) {
    return normalizeIncludePriority(
        candidate?.sourcePriority ?? candidate?.priority
    );
}

function getIncludeCandidateExtensionPriority(candidate = {}) {
    return normalizeIncludePriority(candidate?.extensionPriority);
}

function compareIncludeCandidatePriority(left = {}, right = {}) {
    const leftSourcePriority = getIncludeCandidateSourcePriority(left);
    const rightSourcePriority = getIncludeCandidateSourcePriority(right);
    if (leftSourcePriority !== rightSourcePriority) {
        return leftSourcePriority < rightSourcePriority ? -1 : 1;
    }

    const leftExtensionPriority = getIncludeCandidateExtensionPriority(left);
    const rightExtensionPriority = getIncludeCandidateExtensionPriority(right);
    if (leftExtensionPriority !== rightExtensionPriority) {
        return leftExtensionPriority < rightExtensionPriority ? -1 : 1;
    }

    return 0;
}

function isPreferredIncludeCandidate(candidate, existing = null) {
    if (!existing) return true;
    return compareIncludeCandidatePriority(candidate, existing) < 0;
}

module.exports = {
    DEFAULT_INCLUDE_SOURCE_PRIORITY,
    INCLUDE_RESOLUTION_PRIORITY,
    compareIncludeCandidatePriority,
    getIncludeCandidateExtensionPriority,
    getIncludeCandidateSourcePriority,
    isPreferredIncludeCandidate,
    normalizeIncludePriority
};
