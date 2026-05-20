const { createSharedTextDiagnostics } = require('./shared-text-diagnostics');
const { createSharedContextDiagnostics } = require('./shared-context-diagnostics');
const { createSharedCallDiagnostics } = require('./shared-call-diagnostics');
const { createSharedExpressionDiagnostics } = require('../../core/validation');

function createLiveValidationSharedDiagnostics(deps) {
    const {
        vscode,
        t,
        isEscapedQuote,
        collectIndexedAccessExpressionsFromLine,
        resolveIndexedAccessValidationChain,
        splitTopLevel,
        getPreferredFunctionHoverMatch,
        isFunctionLikeDecl,
        isFunctionLikeDefineDecl,
        stripTagCastsForValidation,
        stripTrailingSemicolon,
        findFirstNonWhitespaceIndex,
        findBalancedGroupEnd,
        getCoreArrayShapeIssue,
        hasIncludeFunctionTwin,
        explainParamDeclCompat,
        parseParamMeta,
        parseOperatorOverloadToken,
        parseDimsParts,
        parseDimSpec,
        getEffectiveDeclDimParts,
        computeFunctionRangeMaps,
        areLiveValidationWarningsEnabled,
        settingsService,
        nonAsciiCharRe,
        isPawnIdentifierBoundaryChar,
        readIdentifierAt,
        getRedundantSizeofDefaultIssue
    } = deps;

    const isOperatorOverloadName = name => parseOperatorOverloadToken(name) !== null;

    const text = createSharedTextDiagnostics({
        vscode,
        t,
        isEscapedQuote,
        nonAsciiCharRe,
        isPawnIdentifierBoundaryChar
    });
    const context = createSharedContextDiagnostics({
        settingsService,
        areLiveValidationWarningsEnabled,
        computeFunctionRangeMaps,
        getPreferredFunctionHoverMatch,
        hasIncludeFunctionTwin,
        isFunctionLikeDecl,
        isFunctionLikeDefineDecl,
        isEscapedQuote,
        isOperatorOverloadName
    });
    const expression = createSharedExpressionDiagnostics({
        vscode,
        t,
        areWarningDiagnosticsEnabled: context.areWarningDiagnosticsEnabled,
        getWarningSeverity: text.getWarningSeverity,
        getCoreArrayShapeIssue,
        stripTrailingSemicolon,
        stripTagCastsForValidation,
        splitTopLevel,
        explainParamDeclCompat,
        isFunctionLikeDefineDecl,
        isFunctionLikeDecl,
        isOperatorOverloadName,
        parseDimsParts,
        parseDimSpec,
        getEffectiveDeclDimParts,
        findFirstNonWhitespaceIndex,
        findBalancedGroupEnd,
        readIdentifierAt
    });
    const call = createSharedCallDiagnostics({
        t,
        collectIndexedAccessExpressionsFromLine,
        resolveIndexedAccessValidationChain,
        createOffsetRange: text.createOffsetRange,
        createLiveValidationDiagnostic: text.createLiveValidationDiagnostic,
        findVariableDeclByName: expression.findVariableDeclByName,
        parseParamMeta,
        stripTrailingSemicolon,
        findTopLevelAssignmentOperatorIndex: expression.findTopLevelAssignmentOperatorIndex,
        getAssignmentOperatorText: expression.getAssignmentOperatorText,
        findFirstNonWhitespaceIndex,
        findBalancedGroupEnd,
        readIdentifierAt,
        isOperatorOverloadName: expression.isOperatorOverloadName,
        getRedundantSizeofDefaultIssue,
        areWarningDiagnosticsEnabled: context.areWarningDiagnosticsEnabled,
        getWarningSeverity: text.getWarningSeverity
    });

    return {
        ...text,
        ...context,
        ...expression,
        ...call
    };
}

module.exports = { createLiveValidationSharedDiagnostics };
