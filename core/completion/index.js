const {
    COMPLETION_CALL_ARGUMENT_MODE_ALL,
    COMPLETION_CALL_ARGUMENT_MODE_REQUIRED_BEFORE_DEFAULT,
    createCompletionInsertTextCore,
    normalizeCompletionCallArgumentMode
} = require('./insert-text');
const {
    DEFAULT_MIN_FUZZY_PREFIX_LENGTH,
    compareCompletionMatches,
    getBestCompletionMatch,
    getCompletionMatch,
    normalizeCompletionMatchText,
    withCompletionMatchSortPrefix
} = require('./matching');
const {
    compareCompletionCandidatePriority,
    dedupeCompletionCandidates,
    getCompletionCandidateDedupeKey,
    getCompletionCandidateSourcePriority,
    isCompletionCandidateDeprecated,
    normalizeCompletionCandidateDedupeName
} = require('./candidates');

module.exports = {
    COMPLETION_CALL_ARGUMENT_MODE_ALL,
    COMPLETION_CALL_ARGUMENT_MODE_REQUIRED_BEFORE_DEFAULT,
    DEFAULT_MIN_FUZZY_PREFIX_LENGTH,
    compareCompletionCandidatePriority,
    compareCompletionMatches,
    dedupeCompletionCandidates,
    getBestCompletionMatch,
    getCompletionCandidateDedupeKey,
    getCompletionCandidateSourcePriority,
    getCompletionMatch,
    isCompletionCandidateDeprecated,
    normalizeCompletionMatchText,
    normalizeCompletionCandidateDedupeName,
    normalizeCompletionCallArgumentMode,
    createCompletionInsertTextCore,
    withCompletionMatchSortPrefix
};
