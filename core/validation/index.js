const { createValidationCore } = require('./runtime');
const { createInitializerDiagnostics } = require('./initializer-diagnostics');
const { createSharedExpressionDiagnostics } = require('./shared-expression-diagnostics');
const { createDeprecatedSymbolPolicy } = require('./deprecated-symbol');
const { createSymbolUsageDiagnostics } = require('./usage-diagnostics');
const { createDynamicUsageDiagnostics } = require('./dynamic-usage');

module.exports = {
    createValidationCore,
    createInitializerDiagnostics,
    createSharedExpressionDiagnostics,
    createDeprecatedSymbolPolicy,
    createSymbolUsageDiagnostics,
    createDynamicUsageDiagnostics
};
