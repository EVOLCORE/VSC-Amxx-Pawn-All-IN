function createActivationState() {
    return {
        includeFileDecls: new Map(),
        includeFileTextCache: new Map(),
        fileSnapshotCache: new Map(),
        commentAnalysisCache: new Map(),
        ctrlCharStateCache: new Map(),
        resolvedIncludePathCache: new Map(),
        searchPathCache: new Map(),
        projectIncludeSourceCache: new Map(),
        fileDeclParseCache: new Map(),
        activeIncludeDeclsCache: new Map(),
        documentWarmupTimers: new Map(),
        documentContextCache: new Map(),
        sharedDocumentContextCache: new Map(),
        documentContextVersionHistory: new Map(),
        documentEditImpactHistory: new Map(),
        documentContextFileLru: new Map(),
        declNameBucketCache: new WeakMap(),
        funcArgsParseCache: new Map(),
        liveValidationTimers: new Map(),
        liveValidationFullResultCache: new Map(),
        includeDocumentModelWarmCache: new Map(),
        lastSavedDocumentVersions: new Map(),
        workspaceIncludeWatcherState: {
            watchers: [],
            rootVersions: new Map(),
            signature: ''
        },
        dependencyFreshnessState: {
            version: 1,
            checks: new WeakMap()
        }
    };
}

module.exports = {
    createActivationState
};
