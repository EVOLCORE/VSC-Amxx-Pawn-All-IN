function createLazyRuntimeTranslator(vscodeModule) {
    let runtimeLocalization = null;
    return (key, variables = null, fallback = null) => {
        if (!runtimeLocalization) {
            const { createRuntimeLocalization } = require('./localization');
            runtimeLocalization = createRuntimeLocalization(vscodeModule);
        }
        return runtimeLocalization.t(key, variables, fallback);
    };
}

module.exports = {
    createLazyRuntimeTranslator
};
