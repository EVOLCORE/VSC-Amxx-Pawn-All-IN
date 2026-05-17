const { createEditImpactResolver } = require('../core/document-context/edit-impact');

function createCacheMaintenanceService(deps) {
    const {
        vscode,
        isPawnDocument,
        normalizeFsPath,
        includeFileDecls,
        includeFileTextCache,
        fileSnapshotCache,
        commentAnalysisCache,
        ctrlCharStateCache,
        resolvedIncludePathCache,
        searchPathCache,
        projectIncludeSourceCache,
        fileDeclParseCache,
        activeIncludeDeclsCache,
        sharedDocumentContextCache,
        documentContextCache,
        documentEditImpactHistory,
        documentContextFileLru,
        funcArgsParseCache,
        liveValidationFullResultCache,
        includeDocumentModelWarmCache,
        documentWarmupTimers,
        bumpDependencyFreshnessVersion,
        invalidateFileStamp,
        clearFileDeclParseCacheForFile,
        clearActiveIncludeDeclsCacheForFile,
        clearDocumentContextCacheForFile,
        clearIncludeDeclCacheForFile,
        clearIncludeFileTextCacheForFile,
        clearFileSnapshotCacheForFile,
        clearIncludeCompletionSourceCache = null,
        clearScheduledWarmup,
        parsePreprocessorDirectiveLine,
        isExplicitDeclarationStartLine,
        warmDocumentContext,
        warmIncludedDocumentModels
    } = deps;

    const editImpactResolver = createEditImpactResolver({
        normalizeFsPath,
        fileDeclParseCache,
        parsePreprocessorDirectiveLine,
        isExplicitDeclarationStartLine
    });
    const {
        resolveDocumentEditImpact,
        summarizeDocumentEditImpact
    } = editImpactResolver;

    function recordDocumentEditImpact(filePath = '', version = 0, editImpact = null) {
        const normalized = normalizeFsPath(filePath);
        if (!normalized || !Number.isInteger(version) || version <= 0 || !editImpact) {
            return;
        }
        documentEditImpactHistory.set(normalized, { version, editImpact });
    }

    function invalidateDocumentCaches(filePath = '', options = {}) {
        if (!filePath) return;
        if (options.editImpact?.kind === 'incremental') {
            return;
        }
        clearFileDeclParseCacheForFile(filePath);
        clearActiveIncludeDeclsCacheForFile(filePath);
        clearDocumentContextCacheForFile(filePath);
        if (options.clearIncludeDecls) {
            clearIncludeDeclCacheForFile(filePath);
        }
        clearIncludeFileTextCacheForFile(filePath);
        clearFileSnapshotCacheForFile(filePath);
        if (typeof invalidateFileStamp === 'function') {
            invalidateFileStamp(filePath);
        }
        if (options.clearAllActiveIncludeDecls) {
            activeIncludeDeclsCache.clear();
        }
    }

    function resetCachesAndWarmActiveDocument() {
        includeFileDecls.clear();
        includeFileTextCache.clear();
        fileSnapshotCache.clear();
        commentAnalysisCache.clear();
        ctrlCharStateCache.clear();
        resolvedIncludePathCache.clear();
        searchPathCache.clear();
        projectIncludeSourceCache.clear();
        fileDeclParseCache.clear();
        activeIncludeDeclsCache.clear();
        sharedDocumentContextCache.clear();
        documentContextCache.clear();
        documentEditImpactHistory.clear();
        documentContextFileLru.clear();
        funcArgsParseCache.clear();
        liveValidationFullResultCache.clear();
        includeDocumentModelWarmCache.clear();
        if (typeof clearIncludeCompletionSourceCache === 'function') {
            clearIncludeCompletionSourceCache();
        }
        if (typeof bumpDependencyFreshnessVersion === 'function') {
            bumpDependencyFreshnessVersion();
        }
        for (const filePath of documentWarmupTimers.keys()) {
            clearScheduledWarmup(filePath);
        }

        const activeDoc = vscode.window.activeTextEditor?.document || null;
        if (isPawnDocument(activeDoc)) {
            warmDocumentContext(activeDoc);
            warmIncludedDocumentModels(activeDoc);
        }
    }

    return {
        summarizeDocumentEditImpact,
        resolveDocumentEditImpact,
        recordDocumentEditImpact,
        invalidateDocumentCaches,
        resetCachesAndWarmActiveDocument
    };
}

module.exports = { createCacheMaintenanceService };
