const { createThemeRecommendationFeature } = require('../../features/theme-recommendation');
const { createCommandLinkService } = require('../../services/command-links');
const { createDocumentLanguageService } = require('../../services/document-language');

function buildFeatureSupport(deps) {
    const { vscode } = deps;
    const { settingsRuntime, sharedRuntime } = deps.coreRuntime;
    const {
        matchesConfiguredPawnFileExtension,
        shouldDetectPawnLanguageByIncludes,
        shouldShowThemeRecommendation,
        isHoverGoToDefinitionLinksEnabled
    } = settingsRuntime;
    const {
        t,
        isPawnDocument,
        getSearchPaths,
        resolveInclude,
        getIncludeNameFromLine,
        parsePreprocessorDirectiveLine
    } = sharedRuntime;

    const { ensureConfiguredPawnLanguage } = createDocumentLanguageService({
        vscode,
        isPawnDocument,
        matchesConfiguredPawnFileExtension,
        shouldDetectPawnLanguageByIncludes,
        getSearchPaths,
        resolveInclude,
        getIncludeNameFromLine,
        parsePreprocessorDirectiveLine
    });

    const themeRecommendationFeature = createThemeRecommendationFeature({
        vscode,
        t,
        isPawnDocument,
        shouldShowThemeRecommendation
    });

    const { buildCommandLink } = createCommandLinkService({
        t,
        isHoverGoToDefinitionLinksEnabled
    });

    return {
        ensureConfiguredPawnLanguage,
        themeRecommendationFeature,
        buildCommandLink
    };
}

module.exports = { buildFeatureSupport };
