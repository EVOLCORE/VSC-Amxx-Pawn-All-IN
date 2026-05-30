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
    let extensionCacheSignature = '';
    let extensionCacheSource = null;
    const documentCache = new WeakMap();

    const getExtensions = () => {
        const rawExtensions = typeof getIncludeFileExtensions === 'function'
            ? getIncludeFileExtensions()
            : [];
        if (rawExtensions === extensionCacheSource && extensionCacheValue) {
            return extensionCacheValue;
        }
        const cacheKey = Array.isArray(rawExtensions)
            ? rawExtensions.join('\0')
            : '__default__';
        if (cacheKey === extensionCacheKey && extensionCacheValue) {
            extensionCacheSource = rawExtensions;
            return extensionCacheValue;
        }
        extensionCacheSource = rawExtensions;
        extensionCacheKey = cacheKey;
        extensionCacheValue = normalizeIncludeDocumentExtensionList(rawExtensions);
        extensionCacheSignature = extensionCacheValue.join('|');
        return extensionCacheValue;
    };

    const getExtensionSignature = () => {
        getExtensions();
        return extensionCacheSignature;
    };

    function isIncludeDocument(document) {
        const rawFileName = String(document?.fileName || '');
        if (!rawFileName) return false;
        const signature = getExtensionSignature();
        const cached = documentCache.get(document);
        if (cached?.rawFileName === rawFileName && cached.signature === signature) {
            return cached.value;
        }
        const fileName = rawFileName.toLowerCase();
        const extensions = getExtensions();
        const value = extensions.some(ext => fileName.endsWith(ext));
        documentCache.set(document, { rawFileName, signature, value });
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
