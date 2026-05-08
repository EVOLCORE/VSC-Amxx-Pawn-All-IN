const {
    createDocumentCacheUtils,
    createDocumentContextStateCore
} = require('../../core/document-context/index');

function createDocumentStateRuntime(deps) {
    const {
        vscode,
        fs,
        normalizeFsPath,
        documentContextFileLru,
        includeDocumentModelWarmCache,
        includeFileTextCache,
        dependencyFreshnessState,
        includeFileDecls,
        fileDeclParseCache,
        activeIncludeDeclsCache,
        sharedDocumentContextCache,
        documentContextCache,
        documentContextVersionHistory,
        funcArgsParseCache,
        liveValidationFullResultCache
    } = deps;

    let clearDocumentContextCacheForFile = null;
    const stateRuntime = createDocumentContextStateCore({
        vscode,
        fs,
        normalizeFsPath,
        documentContextFileLru,
        includeDocumentModelWarmCache,
        includeFileTextCache,
        dependencyFreshnessState,
        getDocumentContextCacheFileLimit: deps.getDocumentContextCacheFileLimit,
        clearDocumentContextCacheForFile: (...args) => clearDocumentContextCacheForFile(...args)
    });
    const documentCacheUtils = createDocumentCacheUtils({
        normalizeFsPath,
        getDefineStateKey: stateRuntime.getDefineStateKey,
        includeFileDecls,
        fileDeclParseCache,
        activeIncludeDeclsCache,
        sharedDocumentContextCache,
        documentContextCache,
        documentContextVersionHistory,
        documentContextFileLru,
        funcArgsParseCache,
        liveValidationFullResultCache
    });
    clearDocumentContextCacheForFile = documentCacheUtils.clearDocumentContextCacheForFile;

    return {
        ...stateRuntime,
        getIncludeDeclCacheKey: documentCacheUtils.getIncludeDeclCacheKey,
        getActiveIncludeDeclsCacheKey: documentCacheUtils.getActiveIncludeDeclsCacheKey,
        getSharedDocumentContextCacheKey: documentCacheUtils.getSharedDocumentContextCacheKey,
        getDocumentContextCacheKey: documentCacheUtils.getDocumentContextCacheKey,
        getLiveValidationFullCacheKey: documentCacheUtils.getLiveValidationFullCacheKey,
        getFuncArgsParseCacheKey: documentCacheUtils.getFuncArgsParseCacheKey,
        trackVersionedDocumentCacheVersion: documentCacheUtils.trackVersionedDocumentCacheVersion,
        clearIncludeDeclCacheForFile: documentCacheUtils.clearIncludeDeclCacheForFile,
        clearFileDeclParseCacheForFile: documentCacheUtils.clearFileDeclParseCacheForFile,
        clearActiveIncludeDeclsCacheForFile: documentCacheUtils.clearActiveIncludeDeclsCacheForFile,
        clearDocumentContextCacheForFile
    };
}

module.exports = { createDocumentStateRuntime };
