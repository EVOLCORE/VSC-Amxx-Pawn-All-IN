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
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        findHeaderFunctionByNameAtPosition,
        findDefinitionContext,
        getPreferredFunctionHoverMatch,
        hasIncludeFunctionTwin,
        findFirstNavigableDecl,
        splitTopLevel,
        isFunctionLikeDecl,
        isFunctionLikeDefineDecl,
        BUILTIN_DECLS,
        buildSig
    } = sharedRuntime;

    const completionFeature = createCompletionFeature({
        vscode,
        t,
        getPawnDocumentContext,
        splitTopLevel,
        isFunctionLikeDecl,
        isFunctionLikeDefineDecl,
        isSameFilePath,
        BUILTIN_DECLS,
        buildSig,
        buildCommandLink: support.buildCommandLink,
        isCompletionEnabled: () => settingsService?.isCompletionEnabled?.() !== false,
        completionOutputChannel: liveValidationOutputChannel
    });

    const navigationFeature = createNavigationFeature({
        vscode,
        t,
        normalizeFsPath,
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
