const COMPILER_INCLUDE_FILE_EXTENSIONS = Object.freeze(['.inc', '.p', '.i', '.pawn']);
const DEFAULT_CUSTOM_INCLUDE_FILE_EXTENSIONS = Object.freeze(['.inl']);

function normalizeIncludeExtensionList(values, fallback = []) {
    const source = Array.isArray(values) ? values : fallback;
    const result = [];
    for (const value of source || []) {
        let ext = String(value || '').trim().toLowerCase();
        if (!ext) continue;
        if (!ext.startsWith('.')) ext = `.${ext}`;
        if (!result.includes(ext)) result.push(ext);
    }
    return result;
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
