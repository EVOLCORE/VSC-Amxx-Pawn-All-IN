const {
    createCoreSyntaxPrelude,
    createBaseSyntaxRuntime
} = require('./core-wiring/base-syntax');
const { createDeclarationSupportRuntime } = require('./core-wiring/declaration-support');
const { createAnalysisRuntime } = require('./core-wiring/analysis');
const { createDocumentSystemRuntime } = require('./core-wiring/document-system');
const { createPreprocessorRuntime } = require('./core-wiring/preprocessor');
const { createDocumentStateRuntime } = require('./core-wiring/document-state');
const { createCoreRuntimeBundle } = require('./core-wiring/runtime-bundle');

function buildCoreActivationRuntime(deps) {
    const {
        vscode,
        fs,
        path,
        context,
        t,
        settingsService,
        state
    } = deps;
    const {
        includeFileDecls,
        projectIncludeSourceCache,
        fileDeclParseCache,
        activeIncludeDeclsCache,
        documentWarmupTimers,
        documentContextCache,
        sharedDocumentContextCache,
        documentContextVersionHistory,
        documentEditImpactHistory,
        documentContextFileLru,
        declNameBucketCache,
        funcArgsParseCache,
        liveValidationFullResultCache,
        includeDocumentModelWarmCache,
        includeFileTextCache,
        fileSnapshotCache,
        commentAnalysisCache,
        ctrlCharStateCache,
        resolvedIncludePathCache,
        searchPathCache,
        dependencyFreshnessState
    } = state;
    const {
        refresh: refreshExtensionSettings,
        getIncludeFileExtensions,
        getDocumentContextCacheFileLimit,
        getIncludeDocumentWarmupFileLimit,
        getPersistentIncludeDeclarationCacheMaxBytes,
        getGlobalIncludePaths,
        getProjectLocalIncludePaths
    } = settingsService;

    const syntaxPrelude = createCoreSyntaxPrelude({ t });
    const {
        INCLUDE_LINE_RE,
        FORBIDDEN,
        BUILTIN_DECLS,
        VAR_MODS,
        OPERATOR_SYMBOLS,
        MOD_RE,
        TAG_RE,
        NAME_RE,
        normalizeFsPath,
        isSameFilePath
    } = syntaxPrelude;
    let readPersistentIncludePreprocessedState = null;
    let writePersistentIncludePreprocessedState = null;
    const documentStateRuntime = createDocumentStateRuntime({
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
        documentContextFileLru,
        funcArgsParseCache,
        liveValidationFullResultCache,
        getDocumentContextCacheFileLimit
    });
    const {
        cloneDefineDecls,
        getDefineStateKey,
        touchDocumentContextCacheFile,
        pruneDocumentContextCache,
        getFileStamp,
        readNormalizedFileContent,
        clearIncludeFileTextCacheForFile,
        invalidateFileStamp,
        isSameFileStamp,
        touchWarmedIncludeDocument,
        buildDependencyStampMap,
        bumpDependencyFreshnessVersion,
        getDependencyFreshnessVersion,
        areDependencyStampsFresh,
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
    } = documentStateRuntime;

    let getSearchPaths = null;
    let resolveInclude = null;
    let parseForInit = null;
    let parseEnumBlock = null;
    let isPotentialEnumDeclarationLine = null;
    let isPotentialDeclarationStartLine = null;
    let isExplicitDeclarationStartLine = null;
    let parseDeclLine = null;
    let parseDimsParts = null;
    let parseDimSpec = null;
    let evaluatePawnNumericExpr = null;
    let collectActiveDefineDecls = null;
    let parseFileDecls = null;
    let preprocessPawnContent = null;
    let parsePreprocessorDirectiveLine = null;
    let parsePreprocessorSingleIdentifierPayload = null;
    let parsePreprocessorDefineDirective = null;
    let parseEnumHeaderSpec = null;
    let applyEnumStep = null;
    let getIncludePreprocessedStateKey = null;

    const baseSyntaxRuntime = createBaseSyntaxRuntime({
        vscode,
        normalizeFsPath,
        getSearchPaths: (...args) => getSearchPaths(...args),
        resolveInclude: (...args) => resolveInclude(...args),
        INCLUDE_LINE_RE,
        OPERATOR_SYMBOLS,
        commentAnalysisCache,
        ctrlCharStateCache,
        fileSnapshotCache,
        readNormalizedFileContent
    });
    const {
        getActiveCtrlChar,
        getCtrlCharStateForContent,
        withCtrlCharForContent,
        createCtrlCharResolver,
        isEscapedQuote,
        getIncludeNameFromLine,
        isPawnDocument,
        getDocumentTextAndResolver,
        stripLineComment,
        stripCommentsFromLines,
        netParenDepth,
        extractParenContent,
        splitTopLevel,
        splitTopLevelWithRanges,
        unwrapOuterParens,
        stripRootTagCasts,
        parseIndexedAccessExpression,
        parseTopLevelTernaryExpression,
        parseBraceArrayLiteralExpression,
        looksLikePawnExpressionFragment,
        extractDocs,
        parseDims,
        parseValueAndRemainder,
        isLinePositionInsideCommentOrString,
        getLookupTokenAtPosition,
        computeLineDepths,
        getFileSnapshot,
        clearFileSnapshotCacheForFile,
        measurePawnStringLiteral,
        isVariadicParam,
        getLabelDeclarationIssues,
        parseLabelDeclaration,
        collectGotoReferences,
        parseFunctionStateSpecTail,
        parseFunctionStateSpecFromHeaderText,
        parseStateStatement,
        collectFunctionStateIssues,
        areStatefulFunctionRedeclarationsAllowed,
        getStateStatementIssues,
        escapeRegExp,
        normalizeExtensionList,
        normalizeLiveValidationIssueMode,
        areLiveValidationWarningsEnabled,
        getDocumentFingerprint,
        isPawnIdentifierStartChar,
        isPawnIdentifierContinueChar,
        isPawnIdentifierBoundaryChar,
        buildCommentAnalysis,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis
    } = baseSyntaxRuntime;
    refreshExtensionSettings();

    const declarationSupportRuntime = createDeclarationSupportRuntime({
        t,
        declNameBucketCache,
        BUILTIN_DECLS,
        getActiveCtrlChar,
        isEscapedQuote,
        stripLineComment,
        netParenDepth,
        measurePawnStringLiteral,
        parseBraceArrayLiteralExpression,
        parseDimsParts: (...args) => parseDimsParts(...args),
        parseDimSpec: (...args) => parseDimSpec(...args),
        evaluatePawnNumericExpr: (...args) => evaluatePawnNumericExpr(...args),
        parseForInit: (...args) => parseForInit(...args),
        parseDeclLine: (...args) => parseDeclLine(...args)
    });
    const {
        findDepthScopeEndLine,
        computeFunctionRangeMaps,
        findForScopeEndLine,
        parseSingleStatementBodyDecls,
        collectDeclarationText,
        extractEnumSymbolName,
        formatResolvedEnumValueDisplay,
        formatAutoEnumValueDisplay,
        getEnumDeclsForVariableDims,
        buildEnumMemberLine,
        buildSig,
        isFunctionLikeDefineDecl,
        isObjectLikeDefineDecl,
        isFunctionLikeDecl,
        findDeclByNameCached,
        buildDocumentDeclLookup,
        isKnownFunctionName,
        hasIncludeFunctionTwin,
        getDeclMatchKey,
        finalizeDeclMatches,
        collectWordDeclMatches,
        findFirstNavigableDecl
    } = declarationSupportRuntime;
    const preprocessorRuntime = createPreprocessorRuntime({
        evaluatePawnNumericExpr: (...args) => evaluatePawnNumericExpr(...args),
        cloneDefineDecls,
        normalizeFsPath,
        getDefineStateKey,
        getSearchPaths: (...args) => getSearchPaths(...args),
        resolveInclude: (...args) => resolveInclude(...args),
        getIncludeNameFromLine,
        collectDeclarationText,
        stripLineComment,
        readNormalizedFileContent,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis,
        buildCommentAnalysis,
        readCachedIncludePreprocessedState: (...args) => readPersistentIncludePreprocessedState
            ? readPersistentIncludePreprocessedState(...args)
            : null,
        writeCachedIncludePreprocessedState: (...args) => {
            if (writePersistentIncludePreprocessedState) {
                writePersistentIncludePreprocessedState(...args);
            }
        }
    });
    ({
        getIncludePreprocessedStateKey,
        parsePreprocessorDirectiveLine,
        parsePreprocessorSingleIdentifierPayload,
        parsePreprocessorDefineDirective,
        preprocessPawnContent,
        parseEnumHeaderSpec,
        applyEnumStep
    } = preprocessorRuntime);
    const analysisRuntime = createAnalysisRuntime({
        vscode,
        fs,
        t,
        normalizeFsPath,
        getActiveCtrlChar,
        isEscapedQuote,
        measurePawnStringLiteral,
        splitTopLevel,
        splitTopLevelWithRanges,
        escapeRegExp,
        unwrapOuterParens,
        parseTopLevelTernaryExpression,
        extractEnumSymbolName,
        findDeclByNameCached,
        isFunctionLikeDecl,
        BUILTIN_DECLS,
        FORBIDDEN,
        TAG_RE,
        MOD_RE,
        NAME_RE,
        VAR_MODS,
        getLookupTokenAtPosition,
        collectDeclarationText,
        getCtrlCharStateForContent,
        withCtrlCharForContent,
        stripLineComment,
        stripCommentsFromLines,
        extractParenContent,
        parseEnumHeaderSpec,
        formatAutoEnumValueDisplay,
        formatResolvedEnumValueDisplay,
        applyEnumStep,
        extractDocs,
        parseDims,
        parseValueAndRemainder,
        parsePreprocessorDirectiveLine,
        parsePreprocessorSingleIdentifierPayload,
        parsePreprocessorDefineDirective,
        parseFunctionStateSpecTail,
        computeLineDepths,
        preprocessPawnContent,
        buildDependencyStampMap,
        areDependencyStampsFresh,
        fileDeclParseCache,
        getFileSnapshot,
        isObjectLikeDefineDecl,
        isFunctionLikeDefineDecl,
        parseSingleStatementBodyDecls,
        findForScopeEndLine,
        findDepthScopeEndLine,
        getFuncArgsParseCacheKey,
        funcArgsParseCache,
        getDocumentTextAndResolver,
        isKnownFunctionName,
        isVariadicParam,
        isPawnIdentifierStartChar,
        isPawnIdentifierContinueChar
    });
    ({
        parseForInit,
        parseEnumBlock,
        isPotentialEnumDeclarationLine,
        isPotentialDeclarationStartLine,
        isExplicitDeclarationStartLine,
        parseDeclLine,
        parseDimsParts,
        parseDimSpec,
        evaluatePawnNumericExpr,
        collectActiveDefineDecls,
        parseFileDecls
    } = analysisRuntime);

    const documentSystemRuntime = createDocumentSystemRuntime({
        vscode,
        fs,
        path,
        context,
        isPawnDocument,
        normalizeFsPath,
        getGlobalIncludePaths,
        getProjectLocalIncludePaths,
        getIncludeFileExtensions,
        getIncludeDocumentWarmupFileLimit,
        getPersistentIncludeDeclarationCacheMaxBytes,
        resolvedIncludePathCache,
        searchPathCache,
        projectIncludeSourceCache,
        preprocessPawnContent,
        withCtrlCharForContent,
        stripLineComment,
        stripCommentsFromLines,
        getIncludeNameFromLine,
        getIncludePreprocessedStateKey,
        getIncludeDeclCacheKey,
        getActiveIncludeDeclsCacheKey,
        getDefineStateKey,
        includeFileDecls,
        getFileStamp,
        readNormalizedFileContent,
        isSameFileStamp,
        getFileSnapshot,
        getCtrlCharStateForContent,
        computeLineDepths,
        extractDocs,
        parseEnumBlock,
        isPotentialEnumDeclarationLine,
        isPotentialDeclarationStartLine,
        collectDeclarationText,
        parseDeclLine,
        collectActiveDefineDecls,
        activeIncludeDeclsCache,
        areDependencyStampsFresh,
        buildDependencyStampMap,
        normalizeExtensionList,
        createCtrlCharResolver,
        parseFileDecls,
        buildDocumentDeclLookup,
        getDocumentContextCacheKey,
        getSharedDocumentContextCacheKey,
        sharedDocumentContextCache,
        documentContextVersionHistory,
        documentEditImpactHistory,
        documentContextCache,
        trackVersionedDocumentCacheVersion,
        touchDocumentContextCacheFile,
        pruneDocumentContextCache,
        documentWarmupTimers,
        touchWarmedIncludeDocument,
        includeFileTextCache,
        fileSnapshotCache,
        commentAnalysisCache,
        ctrlCharStateCache,
        fileDeclParseCache,
        documentContextFileLru,
        funcArgsParseCache,
        liveValidationFullResultCache,
        includeDocumentModelWarmCache,
        bumpDependencyFreshnessVersion,
        invalidateFileStamp,
        clearFileDeclParseCacheForFile,
        clearActiveIncludeDeclsCacheForFile,
        clearDocumentContextCacheForFile,
        clearIncludeDeclCacheForFile,
        clearIncludeFileTextCacheForFile,
        clearFileSnapshotCacheForFile,
        parsePreprocessorDirectiveLine,
        isExplicitDeclarationStartLine
    });
    ({
        getSearchPaths,
        resolveInclude,
        readPersistentIncludePreprocessedState,
        writePersistentIncludePreprocessedState
    } = documentSystemRuntime);

    return createCoreRuntimeBundle({
        t,
        settingsService,
        state,
        syntaxPrelude,
        baseSyntaxRuntime,
        declarationSupportRuntime,
        analysisRuntime,
        preprocessorRuntime,
        documentStateRuntime,
        documentSystemRuntime
    });
}

module.exports = { buildCoreActivationRuntime };
