const {
    getDefineStateSignature,
    getIncludeEntriesSignatureHash
} = require('../utils/signature');

// Shared cache-key and cache-invalidation helpers for document/include context.
// Keeping these together makes later document-context extraction much safer.
function createDocumentCacheUtils(deps) {
    const {
        normalizeFsPath,
        getDefineStateKey,
        includeFileDecls,
        fileDeclParseCache,
        activeIncludeDeclsCache,
        sharedDocumentContextCache,
        documentContextCache,
        documentContextVersionHistory,
        documentContextFileLru,
        funcArgsParseCache,
        liveValidationFullResultCache
    } = deps;

    const getIncludeDeclCacheKey = (filePath, defineDecls = [], precomputedDefineStateKey = '') =>
        `${normalizeFsPath(filePath)}::${getDefineStateSignature(defineDecls, precomputedDefineStateKey || getDefineStateKey(defineDecls))}`;
    const getActiveIncludeDeclsCacheKey = (filePath, includeEntries = []) => {
        const normalizedPath = normalizeFsPath(filePath);
        const includeSignature = getIncludeEntriesSignatureHash(
            includeEntries,
            normalizeFsPath,
            entry => getDefineStateSignature(entry?.defineDecls || [], entry?.defineStateKey || '')
        );
        return `${normalizedPath}::${includeSignature}`;
    };
    const getSharedDocumentContextCacheKey = (filePath, version, includeDeclsEnabled, documentIdentity = '') => {
        const identityPart = documentIdentity ? `${documentIdentity}::` : '';
        return `${normalizeFsPath(filePath)}::${version}::${identityPart}${includeDeclsEnabled ? 'inc' : 'noinc'}`;
    };
    const getDocumentContextCacheKey = (filePath, version, cursorLine, includeDeclsEnabled, documentIdentity = '', preparseLocals = false) => {
        const identityPart = documentIdentity ? `${documentIdentity}::` : '';
        return `${normalizeFsPath(filePath)}::${version}::${identityPart}${cursorLine === undefined ? '__all__' : cursorLine}::${includeDeclsEnabled ? 'inc' : 'noinc'}::locals:${preparseLocals ? 1 : 0}`;
    };
    const getLiveValidationFullCacheKey = (filePath, version) =>
        `${normalizeFsPath(filePath)}::${version}`;
    const getFuncArgsParseCacheKey = (argsStr, filePath, lineNumber, escapeChar) =>
        `${normalizeFsPath(filePath)}::${lineNumber}::${escapeChar}::${String(argsStr || '')}`;
    const clearVersionedEntriesForVersion = (cacheMap, normalized, version) => {
        const versionPrefix = `${normalized}::${version}::`;
        const exactVersionKey = `${normalized}::${version}`;
        for (const key of cacheMap.keys()) {
            if (key === exactVersionKey || key.startsWith(versionPrefix)) {
                cacheMap.delete(key);
            }
        }
    };

    const clearIncludeDeclCacheForFile = filePath => {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return;
        for (const key of includeFileDecls.keys()) {
            if (key === normalized || key.startsWith(`${normalized}::`)) {
                includeFileDecls.delete(key);
            }
        }
    };

    const clearFileDeclParseCacheForFile = filePath => {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return;
        fileDeclParseCache.delete(normalized);
    };

    const clearActiveIncludeDeclsCacheForFile = filePath => {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return;
        for (const key of activeIncludeDeclsCache.keys()) {
            if (key === normalized || key.startsWith(`${normalized}::`)) {
                activeIncludeDeclsCache.delete(key);
            }
        }
    };

    const clearDocumentContextCacheForFile = filePath => {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return;
        for (const key of sharedDocumentContextCache.keys()) {
            if (key === normalized || key.startsWith(`${normalized}::`)) {
                sharedDocumentContextCache.delete(key);
            }
        }
        for (const key of documentContextCache.keys()) {
            if (key === normalized || key.startsWith(`${normalized}::`)) {
                documentContextCache.delete(key);
            }
        }
        documentContextFileLru.delete(normalized);
        for (const key of funcArgsParseCache.keys()) {
            if (key === normalized || key.startsWith(`${normalized}::`)) {
                funcArgsParseCache.delete(key);
            }
        }
        for (const key of liveValidationFullResultCache.keys()) {
            if (key === normalized || key.startsWith(`${normalized}::`)) {
                liveValidationFullResultCache.delete(key);
            }
        }
        documentContextVersionHistory.delete(normalized);
    };

    const trackVersionedDocumentCacheVersion = (filePath, version, retainVersions = 2) => {
        const normalized = normalizeFsPath(filePath);
        if (!normalized || !Number.isInteger(version)) return;
        const versions = documentContextVersionHistory.get(normalized) || [];
        const nextVersions = versions.filter(item => item !== version);
        nextVersions.push(version);
        while (nextVersions.length > retainVersions) {
            const staleVersion = nextVersions.shift();
            clearVersionedEntriesForVersion(sharedDocumentContextCache, normalized, staleVersion);
            clearVersionedEntriesForVersion(documentContextCache, normalized, staleVersion);
            clearVersionedEntriesForVersion(liveValidationFullResultCache, normalized, staleVersion);
        }
        documentContextVersionHistory.set(normalized, nextVersions);
    };

    return {
        getIncludeDeclCacheKey,
        getActiveIncludeDeclsCacheKey,
        getSharedDocumentContextCacheKey,
        getDocumentContextCacheKey,
        getLiveValidationFullCacheKey,
        getFuncArgsParseCacheKey,
        trackVersionedDocumentCacheVersion,
        clearIncludeDeclCacheForFile,
        clearFileDeclParseCacheForFile,
        clearActiveIncludeDeclsCacheForFile,
        clearDocumentContextCacheForFile
    };
}

module.exports = { createDocumentCacheUtils };
