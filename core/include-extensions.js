const { createUtilityCore } = require('./utils');

const COMPILER_INCLUDE_FILE_EXTENSIONS = Object.freeze(['.inc', '.p', '.i', '.pawn']);
const DEFAULT_CUSTOM_INCLUDE_FILE_EXTENSIONS = Object.freeze(['.inl']);
const { normalizeExtensionList } = createUtilityCore();

function normalizeIncludeExtensionList(values, fallback = []) {
    return normalizeExtensionList(values, fallback);
}

function mergeUniqueExtensions(...lists) {
    const result = [];
    for (const list of lists || []) {
        for (const ext of list || []) {
            if (ext && !result.includes(ext)) result.push(ext);
        }
    }
    return result;
}

function getEffectiveIncludeFileExtensions(configuredExtensions, options = {}) {
    const defaultCustomExtensions = options.useDefaultCustomWhenEmpty === false
        ? []
        : DEFAULT_CUSTOM_INCLUDE_FILE_EXTENSIONS;
    const customExtensions = normalizeIncludeExtensionList(
        configuredExtensions,
        defaultCustomExtensions
    );
    return mergeUniqueExtensions(COMPILER_INCLUDE_FILE_EXTENSIONS, customExtensions);
}

module.exports = {
    COMPILER_INCLUDE_FILE_EXTENSIONS,
    DEFAULT_CUSTOM_INCLUDE_FILE_EXTENSIONS,
    getEffectiveIncludeFileExtensions,
    normalizeIncludeExtensionList
};
