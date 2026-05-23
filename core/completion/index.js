const {
    createCompletionInsertTextCore
} = require('./insert-text');
const {
    COMPLETION_CALL_ARGUMENT_MODE_ALL,
    COMPLETION_CALL_ARGUMENT_MODE_REQUIRED_BEFORE_DEFAULT,
    normalizeCompletionCallArgumentMode
} = require('./call-argument-mode');
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
const {
    COMPLETION_TRIGGER_CHARACTERS,
    INCLUDE_COMPLETION_TRIGGER_CHARACTERS
} = require('./triggers');
const {
    SERVICE_KEYWORD_COMPLETIONS,
    createServiceKeywordCandidateSelector
} = require('./service-keywords');

module.exports = {
    COMPLETION_TRIGGER_CHARACTERS,
    COMPLETION_CALL_ARGUMENT_MODE_ALL,
    COMPLETION_CALL_ARGUMENT_MODE_REQUIRED_BEFORE_DEFAULT,
    DEFAULT_MIN_FUZZY_PREFIX_LENGTH,
    INCLUDE_COMPLETION_TRIGGER_CHARACTERS,
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
    SERVICE_KEYWORD_COMPLETIONS,
    createCompletionInsertTextCore,
    createServiceKeywordCandidateSelector,
    withCompletionMatchSortPrefix
};
