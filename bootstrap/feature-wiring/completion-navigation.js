const { createCompletionFeature } = require('../../features/completion');
const { createNavigationFeature } = require('../../features/navigation');
const { createRenameFeature } = require('../../features/rename');
const { createSemanticTokensFeature } = require('../../features/semantic-tokens');
const { createFormatStringFeature } = require('../../features/format-strings');
const { createSymbolHighlightFeature } = require('../../features/symbol-highlights');
const { createSymbolReferenceCore } = require('../../core/refactor/symbol-references');

function buildCompletionNavigationFeatures(deps, support) {
    const {
        vscode,
        settingsService,
        liveValidationOutputChannel
    } = deps;
    const { sharedRuntime } = deps.coreRuntime;
    const {
        t,
        normalizeFsPath,
        isSameFilePath,
        isPawnDocument,
        getSearchPaths,
        getIncludeCompletionEntries,
        resolveInclude,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        findHeaderFunctionByNameAtPosition,
        findDefinitionContext,
        findVariableDeclarationSpanInRange,
        getPreferredFunctionHoverMatch,
        hasIncludeFunctionTwin,
        findFirstNavigableDecl,
        splitTopLevel,
        splitTopLevelWithRanges,
        parseParamMeta,
        isEscapedQuote,
        isFunctionLikeDecl,
        isFunctionLikeDefineDecl,
        BUILTIN_DECLS,
        buildSig,
        classifyPawnStatementLine,
        countStructuralBraces,
        findFirstNonWhitespaceIndex,
        findKeywordOccurrences,
        skipInlineControlHeader,
        computeFunctionRangeMaps,
        isLinePositionInsideCommentOrString,
        getDocumentTextAndResolver,
        findCallContext,
        findMatchingParenOffset,
        collectInlineNamedCallContexts,
        buildCallArgLayout,
        createLazyCallContextOptions
    } = sharedRuntime;

    const completionFeature = createCompletionFeature({
        vscode,
        t,
        getPawnDocumentContext,
        splitTopLevel,
        parseParamMeta,
        isEscapedQuote,
        isFunctionLikeDecl,
        isFunctionLikeDefineDecl,
        isSameFilePath,
        BUILTIN_DECLS,
        buildSig,
        getIncludeCompletionEntries,
        buildCommandLink: support.buildCommandLink,
        classifyPawnStatementLine,
        countStructuralBraces,
        findFirstNonWhitespaceIndex,
        findKeywordOccurrences,
        skipInlineControlHeader,
        isCompletionEnabled: () => settingsService?.isCompletionEnabled?.() !== false,
        getForwardCompletionBodyStyle: () => settingsService?.getCompletionForwardDeclarationStyle?.() || 'same-line',
        getCompletionCallArgumentMode: () => settingsService?.getCompletionCallArgumentMode?.() || 'required-before-default',
        getCompletionAutoHideDelayMs: () => settingsService?.getCompletionAutoHideDelayMs?.() || 0,
        completionOutputChannel: liveValidationOutputChannel
    });

    const navigationFeature = createNavigationFeature({
        vscode,
        t,
        normalizeFsPath,
        isPawnDocument,
        getSearchPaths,
        resolveInclude,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        findHeaderFunctionByNameAtPosition,
        findDefinitionContext,
        hasIncludeFunctionTwin,
        getPreferredFunctionHoverMatch,
        findFirstNavigableDecl
    });

    const symbolReferenceCore = createSymbolReferenceCore({
        vscode,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        computeFunctionRangeMaps,
        findVariableDeclarationSpanInRange,
        isLinePositionInsideCommentOrString,
        isEscapedQuote,
        isSameFilePath,
        splitTopLevel,
        parseParamMeta,
        isFunctionLikeDecl
    });

    const renameFeature = createRenameFeature({
        vscode,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        computeFunctionRangeMaps,
        findVariableDeclarationSpanInRange,
        isLinePositionInsideCommentOrString,
        isEscapedQuote,
        isSameFilePath,
        splitTopLevel,
        parseParamMeta,
        isFunctionLikeDecl,
        symbolReferenceCore
    });

    const semanticTokensFeature = createSemanticTokensFeature({
        vscode,
        getPawnDocumentContext,
        isLinePositionInsideCommentOrString
    });

    const formatStringFeature = createFormatStringFeature({
        vscode,
        getPawnDocumentContext,
        getDocumentTextAndResolver,
        findCallContext,
        findMatchingParenOffset,
        splitTopLevelWithRanges,
        isEscapedQuote,
        getPreferredFunctionHoverMatch,
        buildCallArgLayout,
        createLazyCallContextOptions,
        isFunctionLikeDefineDecl,
        collectInlineNamedCallContexts
    });

    const symbolHighlightFeature = createSymbolHighlightFeature({
        vscode,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        computeFunctionRangeMaps,
        findVariableDeclarationSpanInRange,
        isLinePositionInsideCommentOrString,
        isEscapedQuote,
        isSameFilePath,
        splitTopLevel,
        parseParamMeta,
        isFunctionLikeDecl,
        symbolReferenceCore
    });

    return {
        completionFeature,
        navigationFeature,
        renameFeature,
        semanticTokensFeature,
        formatStringFeature,
        symbolHighlightFeature
    };
}

module.exports = { buildCompletionNavigationFeatures };
