const { createCommentAnalysisCore } = require('./comment-analysis');
const { createSyntaxCore } = require('./runtime');
const { createSyntaxConstantCore } = require('./constants');
const { createCtrlCharSyntaxCore } = require('./ctrlchar');
const { createPreprocessorSyntaxCore } = require('./preprocessor');
const { createLookupTokenSyntaxCore } = require('./token-lookup');
const { createBraceDepthSyntaxCore } = require('./brace-depth');
const { createLiteralSyntaxCore } = require('./literals');
const { createLineIndexCore } = require('./line-index');
const { createLabelSyntaxCore } = require('./labels');
const { createStateSyntaxCore } = require('./states');
const { createWarningPolicySyntaxCore } = require('./warning-policy');
const { createRationalPolicySyntaxCore } = require('./rational-policy');
const { createTagOverridePolicySyntaxCore } = require('./tag-override-policy');
const { createStatementClassifier } = require('./statement-classifier');
const { createDelimiterSyntaxCore } = require('./delimiters');
const { createPreprocessorLabelSyntaxCore } = require('./preprocessor-label');
const { createTextSyntaxDiagnosticsCore } = require('./text-diagnostics');
const { createSemanticSyntaxCore } = require('./semantic-classifier');
const { createMacroExpansionSyntaxCore } = require('./macro-expander');

module.exports = {
    createCommentAnalysisCore,
    createSyntaxCore,
    createSyntaxConstantCore,
    createCtrlCharSyntaxCore,
    createPreprocessorSyntaxCore,
    createLookupTokenSyntaxCore,
    createBraceDepthSyntaxCore,
    createLiteralSyntaxCore,
    createLineIndexCore,
    createLabelSyntaxCore,
    createStateSyntaxCore,
    createWarningPolicySyntaxCore,
    createRationalPolicySyntaxCore,
    createTagOverridePolicySyntaxCore,
    createStatementClassifier,
    createDelimiterSyntaxCore,
    createPreprocessorLabelSyntaxCore,
    createTextSyntaxDiagnosticsCore,
    createSemanticSyntaxCore,
    createMacroExpansionSyntaxCore
};
