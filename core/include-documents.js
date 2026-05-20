const { getEffectiveIncludeFileExtensions } = require('./include-extensions');

function normalizeIncludeDocumentExtensionList(includeFileExtensions = []) {
    return getEffectiveIncludeFileExtensions(
        Array.isArray(includeFileExtensions) ? includeFileExtensions : [],
        { useDefaultCustomWhenEmpty: false }
    );
}

function isIncludeFilePath(filePath = '', includeFileExtensions = []) {
    const normalizedPath = String(filePath || '').toLowerCase();
    if (!normalizedPath) return false;
    const extensions = normalizeIncludeDocumentExtensionList(includeFileExtensions);
    return extensions.some(ext => normalizedPath.endsWith(ext));
}

function createIncludeDocumentMatcher(getIncludeFileExtensions) {
    let extensionCacheKey = null;
    let extensionCacheValue = null;
    const documentCache = new WeakMap();

    const getExtensions = () => {
        const rawExtensions = typeof getIncludeFileExtensions === 'function'
            ? getIncludeFileExtensions()
            : [];
        const cacheKey = Array.isArray(rawExtensions)
            ? rawExtensions.join('\0')
            : '__default__';
        if (cacheKey === extensionCacheKey && extensionCacheValue) {
            return extensionCacheValue;
        }
        extensionCacheKey = cacheKey;
        extensionCacheValue = normalizeIncludeDocumentExtensionList(rawExtensions);
        return extensionCacheValue;
    };

    function isIncludeDocument(document) {
        const fileName = String(document?.fileName || '').toLowerCase();
        if (!fileName) return false;
        const extensions = getExtensions();
        const signature = extensions.join('|');
        const cached = documentCache.get(document);
        if (cached?.fileName === fileName && cached.signature === signature) {
            return cached.value;
        }
        const value = extensions.some(ext => fileName.endsWith(ext));
        documentCache.set(document, { fileName, signature, value });
        return value;
    }

    return {
        getExtensions,
        isIncludeDocument
    };
}

module.exports = {
    createIncludeDocumentMatcher,
    isIncludeFilePath,
    normalizeIncludeDocumentExtensionList
};
