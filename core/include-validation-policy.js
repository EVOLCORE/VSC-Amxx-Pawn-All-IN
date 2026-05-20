const { createIncludeDocumentMatcher } = require('./include-documents');

function createIncludeValidationPolicy(options = {}) {
    const {
        getIncludeFileExtensions = () => [],
        getIncludeValidationMode = () => 'balanced'
    } = options;

    const includeDocumentMatcher = createIncludeDocumentMatcher(() => getIncludeFileExtensions() || []);
    const getMode = () => getIncludeValidationMode() || 'balanced';
    const isStrictIncludeValidationEnabled = () => getMode() === 'strict';
    const isIncludeDocument = document => includeDocumentMatcher.isIncludeDocument(document);
    const shouldSuppressValidationForDocument = document =>
        isIncludeDocument(document) && !isStrictIncludeValidationEnabled();

    return {
        getIncludeValidationMode: getMode,
        isIncludeDocument,
        isStrictIncludeValidationEnabled,
        shouldSuppressValidationForDocument
    };
}

module.exports = { createIncludeValidationPolicy };
