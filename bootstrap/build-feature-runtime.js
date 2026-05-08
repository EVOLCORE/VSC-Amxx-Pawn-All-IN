const { buildFeatureSupport } = require('./feature-wiring/support');
const { buildLiveValidationFeature } = require('./feature-wiring/live-validation');
const { buildHoverFeatures } = require('./feature-wiring/hover');
const { buildCompletionNavigationFeatures } = require('./feature-wiring/completion-navigation');
const { buildEditorLifecycleFeature } = require('./feature-wiring/editor-lifecycle');

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
        navigationFeature
    } = buildCompletionNavigationFeatures(deps, support);
    const editorLifecycleFeature = buildEditorLifecycleFeature(deps, support, liveValidationRuntime);

    return {
        editorLifecycleFeature,
        persistentHoverFeature,
        hoverFeature,
        buildHoverAtPosition,
        completionFeature,
        navigationFeature
    };
}

module.exports = { buildFeatureActivationRuntime };
