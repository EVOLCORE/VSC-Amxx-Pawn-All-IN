const { createUtilityCore } = require('../../core/utils');
const { createLabelSyntaxCore } = require('../../core/syntax/labels');
const { createStateSyntaxCore } = require('../../core/syntax/states');
const { createWarningPolicySyntaxCore } = require('../../core/syntax/warning-policy');
const { createRationalPolicySyntaxCore } = require('../../core/syntax/rational-policy');
const { createTagOverridePolicySyntaxCore } = require('../../core/syntax/tag-override-policy');
const { createStatementClassifier } = require('../../core/syntax/statement-classifier');
const {
    createInitializerDiagnostics,
    createDeprecatedSymbolPolicy,
    createSymbolUsageDiagnostics,
    createDynamicUsageDiagnostics
} = require('../../core/validation');
const { computeFunctionRangeMaps: defaultComputeFunctionRangeMaps } = require('../../core/declarations/scope');
const { createExpressionDiagnostics } = require('./expression-diagnostics');
const { createIndexedAccessDiagnostics } = require('./indexed-access-diagnostics');
const { createDelimiterDiagnostics } = require('./delimiter-diagnostics');
const { createSymbolDiagnostics } = require('./symbol-diagnostics');
const { createPreprocessorLabelDiagnostics } = require('./preprocessor-label-diagnostics');
const { createStructuralDiagnostics } = require('./structural-diagnostics');
const { createDeclarationDiagnostics } = require('./declaration-diagnostics');
const { createCallDiagnostics } = require('./call-diagnostics');
const { createHeaderDiagnostics } = require('./header-diagnostics');
const { createUsageDiagnostics } = require('./usage-diagnostics');
const { createDynamicUsageLiveDiagnostics } = require('./dynamic-usage-diagnostics');
const { createLiveValidationSharedDiagnostics } = require('./shared-diagnostics');

const {
    isPawnIdentifierBoundaryChar: defaultIsPawnIdentifierBoundaryChar,
    normalizeExtensionList: defaultNormalizeExtensionList,
    areLiveValidationWarningsEnabled: defaultAreLiveValidationWarningsEnabled
} = createUtilityCore();
const {
    collectDeclaredTagNames: defaultCollectDeclaredTagNames,
    getLabelDeclarationIssues: defaultGetLabelDeclarationIssues,
    parseLabelDeclaration: defaultParseLabelDeclaration,
    collectGotoReferences: defaultCollectGotoReferences
} = createLabelSyntaxCore();
const {
    parseFunctionStateSpecFromHeaderText: defaultParseFunctionStateSpecFromHeaderText,
    parseStateStatement: defaultParseStateStatement,
    collectFunctionStateIssues: defaultCollectFunctionStateIssues,
    areStatefulFunctionRedeclarationsAllowed: defaultAreStatefulFunctionRedeclarationsAllowed,
    getStateStatementIssues: defaultGetStateStatementIssues
} = createStateSyntaxCore();
const {
    findPossiblyUnintendedAssignmentInCondition: defaultFindPossiblyUnintendedAssignmentInCondition,
    getRedundantSizeofDefaultIssue: defaultGetRedundantSizeofDefaultIssue,
    getFunctionShouldReturnValueIssue: defaultGetFunctionShouldReturnValueIssue,
    getSymbolTruncationIssue: defaultGetSymbolTruncationIssue,
    getMacroRedefinitionIssue: defaultGetMacroRedefinitionIssue,
    getConstantRedefinitionIssue: defaultGetConstantRedefinitionIssue,
    getUnknownPragmaIssue: defaultGetUnknownPragmaIssue,
    getNestedCommentIssue: defaultGetNestedCommentIssue,
    getConstantControlTestIssue: defaultGetConstantControlTestIssue,
    getStatementHasNoEffectIssue: defaultGetStatementHasNoEffectIssue,
    getUnreachableCodeIssue: defaultGetUnreachableCodeIssue,
    getSelfAssignmentIssue: defaultGetSelfAssignmentIssue,
    getVariableShadowingIssue: defaultGetVariableShadowingIssue,
    getOldStylePrototypeIssue: defaultGetOldStylePrototypeIssue,
    getSymbolNeverUsedIssue: defaultGetSymbolNeverUsedIssue,
    getSymbolAssignedValueNeverUsedIssue: defaultGetSymbolAssignedValueNeverUsedIssue
} = createWarningPolicySyntaxCore();

function createLiveValidationDiagnosticCore(deps) {
    const {
        vscode,
        t,
        collectIndexedAccessExpressionsFromLine,
        findVariableDeclarationSpanInRange,
        shouldSuppressVariableDeclarationValidationInRange,
        resolveIndexedAccessValidationChain,
        explainIndexedAccessDimCompat,
        analyzePreprocessorConditionExpression,
        parsePreprocessorDefineDirective,
        parsePreprocessorDirectiveLine,
        collectPreprocessorDirectiveText,
        collectEnumMemberSyntaxIssues,
        collectVariableDeclarationSyntaxIssuesForLine,
        collectDeclarationText,
        getPreferredFunctionHoverMatch,
        isFunctionLikeDecl,
        isFunctionLikeDefineDecl,
        findUnresolvedReferenceNames,
        isEscapedQuote,
        findMatchingParenOffset,
        splitTopLevelWithRanges,
        splitTopLevel,
        buildCallArgLayout,
        collectCallArgumentIssues,
        collectOperatorOverloadPolicyIssues,
        expandObjectLikeDefineTupleArgPieces,
        hasExpandableObjectLikeDefineTupleArg,
        createHoverTypeAnalysisCache,
        inferArgType,
        inferArrayShapeActualType,
        getExpressionAssignableInfo,
        isSyntacticAssignableExpression,
        looksLikePawnExpressionFragment,
        findArrayMustBeIndexedIssue,
        getScalarAssignmentTagIssue,
        explainArrayShapeDiagnosticIssue,
        explainTypeCompat,
        stripTagCastsForValidation,
        unwrapExpressionForValidation,
        stripTrailingSemicolon,
        findFirstNonWhitespaceIndex,
        findPreviousNonWhitespaceIndex,
        findBalancedGroupEnd,
        isIdentifierStartChar,
        isIdentifierContinueChar,
        isHexLiteralIdentifierTail,
        getArrayShapeIssue: getCoreArrayShapeIssue,
        hasIncludeFunctionTwin,
        explainParamDeclCompat,
        parseParamMeta,
        parseOperatorOverloadToken,
        parseDimsParts,
        parseDimSpec,
        getEffectiveDeclDimParts,
        parseBraceArrayLiteralExpression,
        parseBraceArrayLiteralExpressionDetailed,
        measurePawnStringLiteral,
        evaluatePawnNumericExpr,
        collectDeclaredTagNames = defaultCollectDeclaredTagNames,
        getLabelDeclarationIssues = defaultGetLabelDeclarationIssues,
        parseLabelDeclaration = defaultParseLabelDeclaration,
        collectGotoReferences = defaultCollectGotoReferences,
        parseFunctionStateSpecFromHeaderText = defaultParseFunctionStateSpecFromHeaderText,
        parseStateStatement = defaultParseStateStatement,
        collectFunctionStateIssues = defaultCollectFunctionStateIssues,
        areStatefulFunctionRedeclarationsAllowed = defaultAreStatefulFunctionRedeclarationsAllowed,
        getStateStatementIssues = defaultGetStateStatementIssues,
        findPossiblyUnintendedAssignmentInCondition = defaultFindPossiblyUnintendedAssignmentInCondition,
        getRedundantSizeofDefaultIssue = defaultGetRedundantSizeofDefaultIssue,
        getFunctionShouldReturnValueIssue = defaultGetFunctionShouldReturnValueIssue,
        getSymbolTruncationIssue = defaultGetSymbolTruncationIssue,
        getMacroRedefinitionIssue = defaultGetMacroRedefinitionIssue,
        getConstantRedefinitionIssue = defaultGetConstantRedefinitionIssue,
        getUnknownPragmaIssue = defaultGetUnknownPragmaIssue,
        getNestedCommentIssue = defaultGetNestedCommentIssue,
        getConstantControlTestIssue = defaultGetConstantControlTestIssue,
        getStatementHasNoEffectIssue = defaultGetStatementHasNoEffectIssue,
        getUnreachableCodeIssue = defaultGetUnreachableCodeIssue,
        getSelfAssignmentIssue = defaultGetSelfAssignmentIssue,
        getVariableShadowingIssue = defaultGetVariableShadowingIssue,
        getOldStylePrototypeIssue = defaultGetOldStylePrototypeIssue,
        getSymbolNeverUsedIssue = defaultGetSymbolNeverUsedIssue,
        getSymbolAssignedValueNeverUsedIssue = defaultGetSymbolAssignedValueNeverUsedIssue,
        getPreprocessorDirectiveIssues,
        computeFunctionRangeMaps = defaultComputeFunctionRangeMaps,
        isPawnIdentifierBoundaryChar = defaultIsPawnIdentifierBoundaryChar,
        normalizeExtensionList = defaultNormalizeExtensionList,
        areLiveValidationWarningsEnabled = defaultAreLiveValidationWarningsEnabled,
        settingsService
    } = deps;
    const nonAsciiCharRe = /[^\x00-\x7F]/;
    const MAX_PAWN_ARRAY_DIMENSIONS = 4;
    const rationalPolicyRuntime = createRationalPolicySyntaxCore({
        evaluatePawnNumericExpr
    });
    const tagOverridePolicyRuntime = createTagOverridePolicySyntaxCore({
        isIdentifierStartChar,
        isIdentifierContinueChar
    });
    const effectiveGetInvalidRationalPrecisionIssue = deps.getInvalidRationalPrecisionIssue ||
        rationalPolicyRuntime.getInvalidRationalPrecisionIssue;
    const effectiveGetRationalFormatAlreadyDefinedIssue = deps.getRationalFormatAlreadyDefinedIssue ||
        rationalPolicyRuntime.getRationalFormatAlreadyDefinedIssue;
    const effectiveCollectRationalLiteralPrecisionIssues = deps.collectRationalLiteralPrecisionIssues ||
        rationalPolicyRuntime.collectRationalLiteralPrecisionIssues;
    const effectiveCollectRationalLiteralIssues = deps.collectRationalLiteralIssues ||
        rationalPolicyRuntime.collectRationalLiteralIssues;
    const effectiveCreateRationalStateFromPragma = deps.createRationalStateFromPragma ||
        rationalPolicyRuntime.createRationalStateFromPragma;
    const effectiveParseRationalPragmaPayload = deps.parseRationalPragmaPayload ||
        rationalPolicyRuntime.parseRationalPragmaPayload;
    const effectiveCollectTagOverrideParenthesesIssues = deps.collectTagOverrideParenthesesIssues ||
        tagOverridePolicyRuntime.collectTagOverrideParenthesesIssues;
    const ignoredUnknownSymbolNames = new Set([
        '_',
        'new', 'static', 'stock', 'public', 'private', 'const', 'native', 'forward',
        'return', 'if', 'for', 'while', 'switch', 'case', 'default', 'do', 'else',
        'sizeof', 'defined', 'state', 'goto', 'assert', 'sleep', 'exit', 'enum',
        'true', 'false', 'cellmin', 'cellmax', 'char'
    ]);
    const {
        classifyPawnStatementLine,
        getNoEffectConstantStatementIssue,
        stripLeadingInlineStatementPrefix,
        mayHaveInlineStatementPrefix,
        isLocalDeclarationStatementStart,
        hasControlInlinePrefix,
        countTopLevelSemicolonStatements,
        resolveSwitchCaseLabelValues,
        findDuplicateSwitchCaseEntry,
        rememberSwitchCaseEntry,
        countStructuralBraces,
        findKeywordOccurrences,
        skipInlineControlHeader,
        readIdentifierAt,
        isKeywordAt
    } = createStatementClassifier({
        isEscapedQuote,
        isIdentifierStartChar,
        isIdentifierContinueChar,
        findFirstNonWhitespaceIndex,
        findBalancedGroupEnd,
        stripTrailingSemicolon,
        splitTopLevel,
        evaluatePawnNumericExpr,
        looksLikePawnExpressionFragment
    });
    const {
        getIncludeValidationMode,
        isStrictIncludeValidationEnabled,
        getCallbackSignatureMode,
        areWarningDiagnosticsEnabled,
        shouldIncludeTargetLine,
        isFunctionDefinitionHeaderCall,
        isFunctionLikeLookupDecl,
        isObjectAliasDefineLookupDecl,
        collectInvalidPawnCodeCharacterRuns,
        collectInvalidPawnCodeCharacterDiagnosticsForLine,
        collectMultilinePawnStringLiteralDiagnostics,
        collectPackedStringDefaultLineFlags,
        getLineStringStartQuoteCodes,
        maskStringLiteralContent,
        createOffsetRange,
        createLiveValidationDiagnostic,
        getWarningSeverity,
        getTypeCompatSeverity,
        getLiveArrayShapeIssue,
        isIncludeDocument,
        getResolvedCallSignatureData,
        findDocumentVariableDeclByName,
        getVariableDeclsForLine,
        getMultilineStringLineFlags,
        getFunctionHeaderLines,
        isFunctionHeaderLine,
        getEnumMemberDeclarationLines,
        isEnumMemberDeclarationLine,
        getFunctionRangeMaps,
        getFunctionBodyRangeByLine,
        getHeaderCandidateMeta,
        makeLiveValidationDiagnosticKey,
        createIdentifierDiagnosticForOccurrence,
        getNormalizedDocumentPath,
        getNormalizedDeclPath,
        matchesCurrentDeclarationAssignmentLhs,
        findTopLevelAssignmentOperatorIndex,
        getAssignmentOperatorText,
        parseStandaloneMutationStatement,
        isPreprocessorContinuationLine,
        isPreprocessorDirectiveOrContinuationLine,
        isFunctionLikeAliasWrapperDefine,
        isSingleStatementForInitLine,
        compareFunctionDeclarationsByPrototype,
        compareFunctionReturnByPrototype,
        isOperatorOverloadName,
        normalizeSelfAssignmentExpression,
        getConstMutationMessage,
        getCallArgumentIssueRange,
        findSizeofOperatorIssues,
        findPossiblyUnintendedBitwiseOperationIssues,
        getHeaderParamMeta,
        collectDefaultParamLiveDiagnostics,
        hasLineBreakInsideStringLiteral
    } = createLiveValidationSharedDiagnostics({
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
        normalizeExtensionList,
        areLiveValidationWarningsEnabled,
        settingsService,
        nonAsciiCharRe,
        isPawnIdentifierBoundaryChar,
        readIdentifierAt,
        getRedundantSizeofDefaultIssue
    });
    const {
        isOpenMultilineBraceInitializerLine,
        isOpenMultilineBraceInitializerForCurrentDecl,
        explainArrayInitializerIssue,
        findInvalidArraySizeIssue,
        findInitializerIssueSourceOffset
    } = createInitializerDiagnostics({
        maxPawnArrayDimensions: MAX_PAWN_ARRAY_DIMENSIONS,
        isEscapedQuote,
        unwrapExpressionForValidation,
        stripTagCastsForValidation,
        evaluatePawnNumericExpr,
        parseBraceArrayLiteralExpression,
        parseBraceArrayLiteralExpressionDetailed,
        findUnresolvedReferenceNames,
        parseDimsParts,
        parseDimSpec,
        measurePawnStringLiteral,
        collectInvalidPawnCodeCharacterRuns
    });
    const {
        getDeprecatedSymbolIssue
    } = createDeprecatedSymbolPolicy();
    const {
        collectSymbolUsageIssues
    } = createSymbolUsageDiagnostics({
        getSymbolNeverUsedIssue,
        getSymbolAssignedValueNeverUsedIssue,
        isEscapedQuote,
        splitTopLevel,
        getPreferredFunctionHoverMatch,
        hasIncludeFunctionTwin
    });
    const {
        collectDynamicUsageIssues
    } = createDynamicUsageDiagnostics({
        evaluatePawnNumericExpr,
        getEffectiveDeclDimParts,
        parseDimSpec
    });
    const {
        collectExpressionOperatorLiveDiagnosticsForLine
    } = createExpressionDiagnostics({
        createLiveValidationDiagnostic,
        createOffsetRange,
        findPossiblyUnintendedBitwiseOperationIssues,
        findSizeofOperatorIssues,
        isIncludeDocument,
        isStrictIncludeValidationEnabled,
        t
    });
    const {
        collectIndexedAccessLiveDiagnosticsForLine
    } = createIndexedAccessDiagnostics({
        areWarningDiagnosticsEnabled,
        createLiveValidationDiagnostic,
        createOffsetRange,
        explainIndexedAccessDimCompat,
        findDocumentVariableDeclByName,
        findUnresolvedReferenceNames,
        findVariableDeclarationSpanInRange,
        getTypeCompatSeverity,
        isIncludeDocument,
        parseDimSpec,
        parseDimsParts,
        resolveIndexedAccessValidationChain,
        shouldSuppressVariableDeclarationValidationInRange,
        t
    });
    const {
        collectDelimiterBalanceState
    } = createDelimiterDiagnostics({
        createLiveValidationDiagnostic,
        createOffsetRange,
        isEscapedQuote,
        t,
        vscode
    });
    const {
        collectCallLiveDiagnostics
    } = createCallDiagnostics({
        areWarningDiagnosticsEnabled,
        buildCallArgLayout,
        collectCallArgumentIssues,
        createLiveValidationDiagnostic,
        createOffsetRange,
        explainTypeCompat,
        expandObjectLikeDefineTupleArgPieces,
        findMatchingParenOffset,
        getCallArgumentIssueRange,
        getDeprecatedSymbolIssue,
        getWarningSeverity,
        getResolvedCallSignatureData,
        getTypeCompatSeverity,
        hasExpandableObjectLikeDefineTupleArg,
        hasLineBreakInsideStringLiteral,
        isEscapedQuote,
        isFunctionDefinitionHeaderCall,
        isFunctionLikeDecl,
        isFunctionLikeDefineDecl,
        isIdentifierContinueChar,
        isIdentifierStartChar,
        isIncludeDocument,
        isStrictIncludeValidationEnabled,
        splitTopLevelWithRanges,
        t
    });
    const {
        collectUnknownSymbolLiveDiagnosticsForLine,
        collectStrayTokenLiveDiagnosticsForLine
    } = createSymbolDiagnostics({
        areWarningDiagnosticsEnabled,
        createLiveValidationDiagnostic,
        createOffsetRange,
        looksLikePawnExpressionFragment,
        findDocumentVariableDeclByName,
        findFirstNonWhitespaceIndex,
        findPreviousNonWhitespaceIndex,
        findUnresolvedReferenceNames,
        findVariableDeclarationSpanInRange,
        getMultilineStringLineFlags,
        getSymbolTruncationIssue,
        getWarningSeverity,
        ignoredUnknownSymbolNames,
        isEnumMemberDeclarationLine,
        isEscapedQuote,
        isFunctionHeaderLine,
        isFunctionLikeLookupDecl,
        isHexLiteralIdentifierTail,
        isIdentifierContinueChar,
        isIdentifierStartChar,
        isIncludeDocument,
        isObjectAliasDefineLookupDecl,
        isStrictIncludeValidationEnabled,
        nonAsciiCharRe,
        parseLabelDeclaration,
        parseStateStatement,
        t
    });
    const {
        collectPreprocessorAndLabelLiveDiagnostics
    } = createPreprocessorLabelDiagnostics({
        areWarningDiagnosticsEnabled,
        createLiveValidationDiagnostic,
        createOffsetRange,
        getMacroRedefinitionIssue,
        getNestedCommentIssue,
        getInvalidRationalPrecisionIssue: effectiveGetInvalidRationalPrecisionIssue,
        collectDeclaredTagNames,
        collectTagOverrideParenthesesIssues: effectiveCollectTagOverrideParenthesesIssues,
        getFunctionBodyRangeByLine,
        getSymbolTruncationIssue,
        getRationalFormatAlreadyDefinedIssue: effectiveGetRationalFormatAlreadyDefinedIssue,
        collectRationalLiteralIssues: effectiveCollectRationalLiteralIssues,
        collectRationalLiteralPrecisionIssues: effectiveCollectRationalLiteralPrecisionIssues,
        createRationalStateFromPragma: effectiveCreateRationalStateFromPragma,
        getUnknownPragmaIssue,
        getWarningSeverity,
        ignoredUnknownSymbolNames,
        isEnumMemberDeclarationLine,
        isFunctionHeaderLine,
        getLabelDeclarationIssues,
        parseLabelDeclaration,
        collectGotoReferences,
        collectEnumMemberSyntaxIssues,
        analyzePreprocessorConditionExpression,
        parsePreprocessorDefineDirective,
        parsePreprocessorDirectiveLine,
        collectPreprocessorDirectiveText,
        parseRationalPragmaPayload: effectiveParseRationalPragmaPayload,
        getPreprocessorDirectiveIssues,
        isIncludeDocument,
        isStrictIncludeValidationEnabled,
        maskStringLiteralContent,
        stripLeadingInlineStatementPrefix,
        t,
        vscode
    });
    const {
        collectStructuralLiveDiagnostics
    } = createStructuralDiagnostics({
        areWarningDiagnosticsEnabled,
        classifyPawnStatementLine,
        collectDeclarationText,
        countStructuralBraces,
        countTopLevelSemicolonStatements,
        createHoverTypeAnalysisCache,
        createLiveValidationDiagnostic,
        createOffsetRange,
        evaluatePawnNumericExpr,
        explainArrayShapeDiagnosticIssue,
        findBalancedGroupEnd,
        findPossiblyUnintendedAssignmentInCondition,
        findDuplicateSwitchCaseEntry,
        findFirstNonWhitespaceIndex,
        findKeywordOccurrences,
        getFunctionBodyRangeByLine,
        getFunctionShouldReturnValueIssue,
        getConstantControlTestIssue,
        getLiveArrayShapeIssue,
        getStateStatementIssues,
        getNoEffectConstantStatementIssue,
        getStatementHasNoEffectIssue,
        getUnreachableCodeIssue,
        getWarningSeverity,
        hasControlInlinePrefix,
        inferArrayShapeActualType,
        isFunctionHeaderLine,
        isIncludeDocument,
        isKeywordAt,
        isLocalDeclarationStatementStart,
        isPreprocessorDirectiveOrContinuationLine,
        maskStringLiteralContent,
        mayHaveInlineStatementPrefix,
        rememberSwitchCaseEntry,
        resolveSwitchCaseLabelValues,
        shouldIncludeTargetLine,
        skipInlineControlHeader,
        stripLeadingInlineStatementPrefix,
        stripTrailingSemicolon,
        t,
        vscode
    });
    const {
        collectDeclarationLiveDiagnosticsForLine
    } = createDeclarationDiagnostics({
        areWarningDiagnosticsEnabled,
        createIdentifierDiagnosticForOccurrence,
        createLiveValidationDiagnostic,
        createOffsetRange,
        explainArrayInitializerIssue,
        explainArrayShapeDiagnosticIssue,
        findArrayMustBeIndexedIssue,
        findInvalidArraySizeIssue,
        findInitializerIssueSourceOffset,
        findTopLevelAssignmentOperatorIndex,
        findUnresolvedReferenceNames,
        getAssignmentOperatorText,
        getConstMutationMessage,
        getExpressionAssignableInfo,
        getLiveArrayShapeIssue,
        getScalarAssignmentTagIssue,
        getNormalizedDeclPath,
        getNormalizedDocumentPath,
        getSelfAssignmentIssue,
        getSymbolTruncationIssue,
        getConstantRedefinitionIssue,
        getVariableShadowingIssue,
        collectVariableDeclarationSyntaxIssuesForLine,
        getVariableDeclsForLine,
        getWarningSeverity,
        evaluatePawnNumericExpr,
        inferArgType,
        inferArrayShapeActualType,
        isEscapedQuote,
        isFunctionHeaderLine,
        isSyntacticAssignableExpression,
        isOpenMultilineBraceInitializerForCurrentDecl,
        isOpenMultilineBraceInitializerLine,
        isPreprocessorContinuationLine,
        isSingleStatementForInitLine,
        matchesCurrentDeclarationAssignmentLhs,
        mayHaveInlineStatementPrefix,
        normalizeSelfAssignmentExpression,
        parseStandaloneMutationStatement,
        stripLeadingInlineStatementPrefix,
        stripTrailingSemicolon,
        t
    });
    const {
        collectHeaderLiveDiagnostics
    } = createHeaderDiagnostics({
        areWarningDiagnosticsEnabled,
        collectDefaultParamLiveDiagnostics,
        collectOperatorOverloadPolicyIssues,
        compareFunctionDeclarationsByPrototype,
        compareFunctionReturnByPrototype,
        createLiveValidationDiagnostic,
        createOffsetRange,
        explainParamDeclCompat,
        findMatchingParenOffset,
        getCallbackSignatureMode,
        getHeaderParamMeta,
        getOldStylePrototypeIssue,
        getPreferredFunctionHoverMatch,
        getSymbolTruncationIssue,
        getVariableShadowingIssue,
        getWarningSeverity,
        hasIncludeFunctionTwin,
        parseFunctionStateSpecFromHeaderText,
        collectFunctionStateIssues,
        areStatefulFunctionRedeclarationsAllowed,
        isFunctionLikeAliasWrapperDefine,
        isIncludeDocument,
        isOperatorOverloadName,
        splitTopLevel,
        splitTopLevelWithRanges,
        t,
        vscode
    });
    const {
        collectUsageLiveDiagnostics
    } = createUsageDiagnostics({
        areWarningDiagnosticsEnabled,
        collectSymbolUsageIssues,
        createLiveValidationDiagnostic,
        createOffsetRange,
        getCallbackSignatureMode,
        getFunctionRangeMaps,
        getWarningSeverity,
        isIncludeDocument,
        isStrictIncludeValidationEnabled,
        t
    });
    const {
        collectDynamicUsageLiveDiagnostics
    } = createDynamicUsageLiveDiagnostics({
        areWarningDiagnosticsEnabled,
        collectDynamicUsageIssues,
        createLiveValidationDiagnostic,
        createOffsetRange,
        getFunctionRangeMaps,
        getWarningSeverity,
        isIncludeDocument,
        isStrictIncludeValidationEnabled,
        t
    });

    return {
        createOffsetRange,
        createLiveValidationDiagnostic,
        makeLiveValidationDiagnosticKey,
        getHeaderCandidateMeta,
        getFunctionRangeMaps,
        getFunctionHeaderLines,
        getEnumMemberDeclarationLines,
        collectIndexedAccessLiveDiagnosticsForLine,
        collectDelimiterBalanceState,
        isEnumMemberDeclarationLine,
        collectInvalidPawnCodeCharacterDiagnosticsForLine,
        collectMultilinePawnStringLiteralDiagnostics,
        collectPackedStringDefaultLineFlags,
        getLineStringStartQuoteCodes,
        collectUnknownSymbolLiveDiagnosticsForLine,
        collectStrayTokenLiveDiagnosticsForLine,
        collectExpressionOperatorLiveDiagnosticsForLine,
        collectPreprocessorAndLabelLiveDiagnostics,
        collectStructuralLiveDiagnostics,
        collectDeclarationLiveDiagnosticsForLine,
        collectCallLiveDiagnostics,
        collectHeaderLiveDiagnostics,
        collectUsageLiveDiagnostics,
        collectDynamicUsageLiveDiagnostics
    };
}

module.exports = { createLiveValidationDiagnosticCore };
