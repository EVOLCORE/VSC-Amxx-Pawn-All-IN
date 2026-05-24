const { buildFeatureSupport } = require('./feature-wiring/support');
const { buildLiveValidationFeature } = require('./feature-wiring/live-validation');
const { buildHoverFeatures } = require('./feature-wiring/hover');
const { buildCompletionNavigationFeatures } = require('./feature-wiring/completion-navigation');
const { buildEditorLifecycleFeature } = require('./feature-wiring/editor-lifecycle');
const { createDocumentHighlightFeature } = require('../features/document-highlights');

function buildFeatureActivationRuntime(deps) {
    const support = buildFeatureSupport(deps);
    const liveValidationRuntime = buildLiveValidationFeature(deps, support);
    const {
        persistentHoverFeature,
        hoverFeature,
        buildHoverAtPosition
    } = buildHoverFeatures(deps, support);
    const {
        completionFeature,
        navigationFeature,
        renameFeature,
        semanticTokensFeature,
        formatStringFeature,
        symbolHighlightFeature
    } = buildCompletionNavigationFeatures(deps, support);
    const documentHighlightFeature = createDocumentHighlightFeature({
        vscode: deps.vscode,
        formatStringFeature,
        symbolHighlightFeature
    });
    const editorLifecycleFeature = buildEditorLifecycleFeature(deps, support, liveValidationRuntime);

    return {
        editorLifecycleFeature,
        persistentHoverFeature,
        hoverFeature,
        buildHoverAtPosition,
        completionFeature,
        navigationFeature,
        renameFeature,
        semanticTokensFeature,
        formatStringFeature,
        symbolHighlightFeature,
        documentHighlightFeature
    };
}

module.exports = { buildFeatureActivationRuntime };
