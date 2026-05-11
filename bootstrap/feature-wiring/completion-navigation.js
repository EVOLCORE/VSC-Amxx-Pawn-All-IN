const { createCompletionFeature } = require('../../features/completion');
const { createNavigationFeature } = require('../../features/navigation');

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
        getSearchPaths,
        resolveInclude,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        findHeaderFunctionByNameAtPosition,
        findDefinitionContext,
        getPreferredFunctionHoverMatch,
        hasIncludeFunctionTwin,
        findFirstNavigableDecl,
        splitTopLevel,
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
        skipInlineControlHeader
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
        buildCommandLink: support.buildCommandLink,
        classifyPawnStatementLine,
        countStructuralBraces,
        findFirstNonWhitespaceIndex,
        findKeywordOccurrences,
        skipInlineControlHeader,
        isCompletionEnabled: () => settingsService?.isCompletionEnabled?.() !== false,
        getForwardCompletionBodyStyle: () => settingsService?.getCompletionForwardDeclarationStyle?.() || 'same-line',
        completionOutputChannel: liveValidationOutputChannel
    });

    const navigationFeature = createNavigationFeature({
        vscode,
        t,
        normalizeFsPath,
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

    return {
        completionFeature,
        navigationFeature
    };
}

module.exports = { buildCompletionNavigationFeatures };
