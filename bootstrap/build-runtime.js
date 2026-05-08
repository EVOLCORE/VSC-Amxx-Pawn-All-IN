const { buildCoreActivationRuntime } = require('./build-core-runtime');
const { buildFeatureActivationRuntime } = require('./build-feature-runtime');

function buildActivationRuntime(deps) {
    const coreRuntime = buildCoreActivationRuntime(deps);
    const featureRuntime = buildFeatureActivationRuntime({
        ...deps,
        coreRuntime
    });

    return {
        ...featureRuntime,
        coreRuntime,
        sharedRuntime: coreRuntime.sharedRuntime
    };
}

module.exports = { buildActivationRuntime };
