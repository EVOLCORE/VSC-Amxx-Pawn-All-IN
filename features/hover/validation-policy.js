const { createIncludeValidationPolicy } = require('../../core/include-validation-policy');

function createHoverValidationPolicy(deps) {
    const {
        getIncludeFileExtensions,
        getIncludeValidationMode
    } = deps;

    const policy = createIncludeValidationPolicy({
        getIncludeFileExtensions,
        getIncludeValidationMode
    });
    const shouldSuppressHoverValidationForDocument = document =>
        policy.shouldSuppressValidationForDocument(document);

    return {
        isStrictIncludeValidationEnabled: policy.isStrictIncludeValidationEnabled,
        shouldSuppressHoverValidationForDocument
    };
}

module.exports = { createHoverValidationPolicy };
