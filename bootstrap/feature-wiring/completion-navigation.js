const { createCompletionFeature } = require('../../features/completion');
const { createNavigationFeature } = require('../../features/navigation');
const { createRenameFeature } = require('../../features/rename');
const { createSemanticTokensFeature } = require('../../features/semantic-tokens');
const { createFormatStringFeature } = require('../../features/format-strings');

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

    const renameFeature = createRenameFeature({
        vscode,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        computeFunctionRangeMaps,
        findVariableDeclarationSpanInRange,
        isLinePositionInsideCommentOrString,
        isEscapedQuote,
        isSameFilePath
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
        createLazyCallContextOptions
    });

    return {
        completionFeature,
        navigationFeature,
        renameFeature,
        semanticTokensFeature,
        formatStringFeature
    };
}

module.exports = { buildCompletionNavigationFeatures };
