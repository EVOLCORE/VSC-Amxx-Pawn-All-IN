const { createLiveValidationDiagnosticCore } = require('./diagnostics');
const { createLiveValidationScanner } = require('./scanner');
const { createLiveValidationScheduler } = require('./scheduler');

// Live validation stays behind one factory so activate/bootstrap wiring can stay
// simple while the implementation evolves in smaller focused modules.
function createLiveValidationModule(deps) {
    const diagnosticCore = createLiveValidationDiagnosticCore(deps);
    const { getPawnDocumentContext, ...scannerDeps } = deps;
    const scanner = createLiveValidationScanner({
        ...scannerDeps,
        ...diagnosticCore
    });
    const scheduler = createLiveValidationScheduler({
        ...deps,
        ...scanner
    });

    return {
        ...diagnosticCore,
        ...scanner,
        ...scheduler
    };
}

module.exports = { createLiveValidationModule };
