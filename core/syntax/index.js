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
const {
    createControlContextTracker,
    getCompletionIntent,
    getCompletionControlContext
} = require('./control-context');
const {
    findNextNonEmptyLine,
    findPreviousNonEmptyLine,
    isDoWhileClosingLine,
    isWhileConditionOnlyLine
} = require('./control-lines');
const { computeLineStartGroupContextFlags } = require('./group-context');
const {
    PAWN_INCLUDE_LINE_RE,
    parsePawnIncludeDirectiveTarget,
    getPawnIncludeNameFromLine
} = require('./includes');
const {
    advanceTopLevelScannerState,
    createTopLevelScannerState,
    findTopLevelChar,
    findTopLevelSequence,
    findTopLevelSimpleAssignmentOperator,
    isTopLevelScannerState
} = require('./top-level');
const { createDelimiterSyntaxCore } = require('./delimiters');
const { createPreprocessorLabelSyntaxCore } = require('./preprocessor-label');
const { createTextSyntaxDiagnosticsCore } = require('./text-diagnostics');
const { createSemanticSyntaxCore } = require('./semantic-classifier');
const { createMacroExpansionSyntaxCore } = require('./macro-expander');
const { createVirtualExpandedLineContextCore } = require('./virtual-expanded-line-context');
const { createFastFunctionRangeCore } = require('./function-ranges');
const { findBalancedGroupEnd } = require('./balanced');
const {
    FIXED_PAWN_TAG_NAMES,
    isAnyPawnTagName,
    isFixedPawnTagName,
    normalizeDeclaredPawnTagName,
    normalizePawnTagName
} = require('./tags');
const {
    COMPOUND_PAWN_ASSIGNMENT_OPERATORS,
    isPawnAssignmentCompareNeighbor,
    readPawnAssignmentOperatorAt
} = require('./operators');
const {
    getPreprocessorDirectiveStartIndex,
    isPreprocessorDirectiveLine
} = require('./preprocessor-lines');
const {
    containsPawnIdentifierStartChar,
    getPawnIdentifierName,
    isPawnIdentifierBoundaryChar,
    isPawnIdentifierContinueChar,
    isPawnIdentifierContinueCode,
    isPawnIdentifierName,
    isPawnIdentifierStartChar,
    isPawnIdentifierStartCode,
    readPawnIdentifierAt
} = require('./identifiers');
const {
    findPawnLineTrimEndIndex,
    findNextNonWhitespaceIndex,
    findPreviousNonWhitespaceIndex,
    getPawnLineTrimBounds,
    isPawnHorizontalWhitespaceChar,
    isPawnHorizontalWhitespaceCode,
    isPawnWhitespaceChar,
    isPawnWhitespaceCode,
    skipPawnHorizontalWhitespace,
    skipPawnWhitespace
} = require('./whitespace');
const {
    countLineBreaks,
    countTextLines,
    splitPawnLines
} = require('./lines');
const pawnKeywords = require('./keywords');

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
    createControlContextTracker,
    getCompletionIntent,
    getCompletionControlContext,
    findNextNonEmptyLine,
    findPreviousNonEmptyLine,
    isDoWhileClosingLine,
    isWhileConditionOnlyLine,
    computeLineStartGroupContextFlags,
    PAWN_INCLUDE_LINE_RE,
    parsePawnIncludeDirectiveTarget,
    getPawnIncludeNameFromLine,
    advanceTopLevelScannerState,
    createTopLevelScannerState,
    findTopLevelChar,
    findTopLevelSequence,
    findTopLevelSimpleAssignmentOperator,
    isTopLevelScannerState,
    createDelimiterSyntaxCore,
    createPreprocessorLabelSyntaxCore,
    createTextSyntaxDiagnosticsCore,
    createSemanticSyntaxCore,
    createMacroExpansionSyntaxCore,
    createVirtualExpandedLineContextCore,
    createFastFunctionRangeCore,
    findBalancedGroupEnd,
    FIXED_PAWN_TAG_NAMES,
    isAnyPawnTagName,
    isFixedPawnTagName,
    normalizeDeclaredPawnTagName,
    normalizePawnTagName,
    COMPOUND_PAWN_ASSIGNMENT_OPERATORS,
    isPawnAssignmentCompareNeighbor,
    readPawnAssignmentOperatorAt,
    getPreprocessorDirectiveStartIndex,
    isPreprocessorDirectiveLine,
    containsPawnIdentifierStartChar,
    getPawnIdentifierName,
    isPawnIdentifierBoundaryChar,
    isPawnIdentifierContinueChar,
    isPawnIdentifierContinueCode,
    isPawnIdentifierName,
    isPawnIdentifierStartChar,
    isPawnIdentifierStartCode,
    readPawnIdentifierAt,
    findPawnLineTrimEndIndex,
    findNextNonWhitespaceIndex,
    findPreviousNonWhitespaceIndex,
    getPawnLineTrimBounds,
    isPawnHorizontalWhitespaceChar,
    isPawnHorizontalWhitespaceCode,
    isPawnWhitespaceChar,
    isPawnWhitespaceCode,
    skipPawnHorizontalWhitespace,
    skipPawnWhitespace,
    countLineBreaks,
    countTextLines,
    splitPawnLines,
    ...pawnKeywords
};
