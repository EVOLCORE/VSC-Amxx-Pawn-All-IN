const COMPLETION_CALL_ARGUMENT_MODE_ALL = 'all';
const COMPLETION_CALL_ARGUMENT_MODE_REQUIRED_BEFORE_DEFAULT = 'required-before-default';

function normalizeCompletionCallArgumentMode(value) {
    const text = String(value || '').trim().toLowerCase();
    if (text === COMPLETION_CALL_ARGUMENT_MODE_ALL) return COMPLETION_CALL_ARGUMENT_MODE_ALL;
    return COMPLETION_CALL_ARGUMENT_MODE_REQUIRED_BEFORE_DEFAULT;
}

module.exports = {
    COMPLETION_CALL_ARGUMENT_MODE_ALL,
    COMPLETION_CALL_ARGUMENT_MODE_REQUIRED_BEFORE_DEFAULT,
    normalizeCompletionCallArgumentMode
};
