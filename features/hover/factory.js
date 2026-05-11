const { createHoverFeature } = require('./provider');
const { createHoverContentFeature } = require('./content');
const { createHoverBuilderFeature } = require('./builder');
const { createHoverHelpersFeature } = require('./helpers');
const { createHoverBitmaskFeature } = require('./bitmask');
const { createHoverSignatureFeature } = require('./signature');
const { createHoverEnumInitializerFeature } = require('./enum-initializer');

function createHoverRuntimeFeature(deps) {
    const {
        vscode,
        refreshExtensionSettings,
        affectsAnyConfiguration,
        HOVER_RELEVANT_CONFIG_KEYS,
        getHoverMode,
        getHoverContentMode,
        hoverOutputChannel = null,
        getLiveValidationIssueMode,
        normalizeLiveValidationIssueMode,
        areLiveValidationWarningsEnabled,
        isHoverGoToDefinitionLinksEnabled,
        getIncludeFileExtensions,
        getGlobalIncludePaths,
        getProjectLocalIncludePaths,
        t,
        buildCommandLink,
        getWordAtPosition,
        computeLineDepths,
        findPreferredKnownCallContext,
        findNestedParentCallNameContext,
        findFunctionDeclarationNameContext,
        findDefinitionContext,
        hasIncludeFunctionTwin,
        isKnownFunctionName,
        isNearbyCallContext,
        isMeaningfulCallCursorPosition,
        findIndexedAccessContextAtPosition,
        buildIndexedAccessSelectionModel,
        resolveDefaultAccessSymbolName,
        evaluatePawnNumericExpr,
        FORBIDDEN,
        getActiveCtrlChar,
        stripLineComment,
        isEscapedQuote,
        getDocumentTextAndResolver,
        collectWordDeclMatches,
        BUILTIN_DECLS,
        getDeclMatchKey,
        extractEnumSymbolName,
        parseDimsParts,
        buildSig,
        splitTopLevel,
        splitTopLevelWithRanges,
        buildCallArgLayout,
        collectCallArgumentIssues,
        expandObjectLikeDefineTupleCallArgs,
        createLazyCallContextOptions,
        createHoverTypeAnalysisCache,
        resolveIndexedAccessValidationChain,
        parseIndexedAccessExpression,
        explainIndexedAccessDimCompat,
        isFunctionLikeDefineDecl,
        isSameFilePath,
        isFunctionLikeDecl,
        buildEnumMemberLine,
        getEnumDeclsForVariableDims,
        parseDimSpec,
        measurePawnStringLiteral,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        isLinePositionInsideCommentOrString,
        collectIndexedAccessExpressionsFromLine,
        getCtrlCharStateForContent,
        findVariableDeclarationSpanInRange,
        shouldSuppressVariableDeclarationValidationInRange,
        isVariableDeclarationNameAtPosition,
        findHeaderFunctionByNameAtPosition,
        isOriginalDeclarationHover,
        buildStructuredEnumFieldHover,
        findFunctionCallNameContext,
        getPreferredFunctionHoverMatch,
        parseFuncArgs,
        finalizeDeclMatches,
        resolveArgumentSymbolName,
        applyHoverDisplayNameSuffixToMatches,
        isHoverAtActiveCursor,
        isMeaningfulCallPosition
    } = deps;
    const logHover = message => {
        try {
            hoverOutputChannel?.appendLine?.(`[hover] ${message}`);
        } catch {
            // Hover logging must never affect hover rendering.
        }
    };
    const getHoverCacheSignature = () => [
        `mode:${getHoverMode() || ''}`,
        `content:${getHoverContentMode() || ''}`,
        `issues:${normalizeLiveValidationIssueMode(getLiveValidationIssueMode())}`,
        `links:${isHoverGoToDefinitionLinksEnabled() ? 1 : 0}`,
        `includeExt:${(getIncludeFileExtensions() || []).join(',')}`,
        `global:${(getGlobalIncludePaths() || []).join('|')}`,
        `project:${(getProjectLocalIncludePaths() || []).join('|')}`
    ].join(';');

    const {
        formatBitmaskValueHex,
        formatBitmaskSetBits,
        extractAssignmentBitmaskRhsInfo,
        getBitmaskExpressionSlice,
        findBitmaskExpressionContext,
        buildBitmaskParts,
        splitTopLevelBitmaskTermsWithOffsets: hoverSplitTopLevelBitmaskTermsWithOffsets,
        extractBitmaskLiteralPartLines
    } = createHoverBitmaskFeature({
        getActiveCtrlChar,
        stripLineComment,
        isEscapedQuote,
        getDocumentTextAndResolver,
        evaluatePawnNumericExpr,
        collectWordDeclMatches,
        BUILTIN_DECLS,
        getDeclMatchKey,
        FORBIDDEN
    });

    const { findEnumInitializerMemberContext } = createHoverEnumInitializerFeature({
        vscode,
        getActiveCtrlChar,
        isEscapedQuote,
        getDocumentTextAndResolver,
        parseDimsParts,
        extractEnumSymbolName
    });

    const {
        buildColoredSignatureLine,
        buildColoredVariableAccessLine
    } = createHoverSignatureFeature({
        t,
        buildSig,
        splitTopLevel,
        buildCallArgLayout,
        collectCallArgumentIssues,
        createHoverTypeAnalysisCache,
        resolveIndexedAccessValidationChain,
        parseIndexedAccessExpression,
        parseDimsParts,
        explainIndexedAccessDimCompat,
        isFunctionLikeDefineDecl
    });

    const {
        buildArgHoverInfo,
        buildStructuredEnumFieldHover: hoverStructuredEnumFieldHover,
        buildHoverMarkdown
    } = createHoverContentFeature({
        vscode,
        t,
        getHoverContentMode,
        isSameFilePath,
        buildCommandLink,
        buildSig,
        isFunctionLikeDecl,
        buildColoredVariableAccessLine,
        buildColoredSignatureLine,
        buildEnumMemberLine,
        getEnumDeclsForVariableDims,
        buildBitmaskParts,
        formatBitmaskValueHex,
        formatBitmaskSetBits,
        extractBitmaskLiteralPartLines,
        parseDimsParts,
        parseDimSpec,
        measurePawnStringLiteral,
        getActiveCtrlChar,
        getLiveValidationIssueMode,
        areLiveValidationWarningsEnabled
    });

    const {
        isHoverAtActiveCursor: hoverIsHoverAtActiveCursor,
        findHoveredBitmaskPart,
        findHoveredIndexedAccessContext,
        applyHoverDisplayNameSuffixToMatches: hoverApplyHoverDisplayNameSuffixToMatches,
        resolvePersistentHoverTarget,
        resolveArgumentSymbolName: hoverResolveArgumentSymbolName
    } = createHoverHelpersFeature({
        vscode,
        getWordAtPosition,
        computeLineDepths,
        findPreferredKnownCallContext,
        findNestedParentCallNameContext,
        findFunctionDeclarationNameContext,
        findDefinitionContext,
        hasIncludeFunctionTwin,
        isKnownFunctionName,
        isNearbyCallContext,
        isMeaningfulCallCursorPosition,
        findIndexedAccessContextAtPosition,
        resolveDefaultAccessSymbolName,
        extractAssignmentBitmaskRhsInfo,
        getBitmaskExpressionSlice,
        splitTopLevelBitmaskTermsWithOffsets: hoverSplitTopLevelBitmaskTermsWithOffsets,
        evaluatePawnNumericExpr,
        FORBIDDEN
    });

    const { buildHoverAtPosition } = createHoverBuilderFeature({
        vscode,
        t,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        isLinePositionInsideCommentOrString,
        collectIndexedAccessExpressionsFromLine,
        buildIndexedAccessSelectionModel,
        getCtrlCharStateForContent,
        findVariableDeclarationSpanInRange,
        shouldSuppressVariableDeclarationValidationInRange,
        isVariableDeclarationNameAtPosition,
        findIndexedAccessContextAtPosition,
        findHeaderFunctionByNameAtPosition,
        findBitmaskExpressionContext,
        findHoveredBitmaskPart,
        findEnumInitializerMemberContext,
        isOriginalDeclarationHover,
        collectWordDeclMatches,
        BUILTIN_DECLS,
        buildStructuredEnumFieldHover: buildStructuredEnumFieldHover || hoverStructuredEnumFieldHover,
        buildHoverMarkdown,
        buildArgHoverInfo,
        findDefinitionContext,
        findPreferredKnownCallContext,
        isNearbyCallContext,
        isHoverAtActiveCursor: isHoverAtActiveCursor || hoverIsHoverAtActiveCursor,
        findNestedParentCallNameContext,
        findFunctionCallNameContext,
        getPreferredFunctionHoverMatch,
        extractCallSiteArgs: deps.extractCallSiteArgs,
        hasIncludeFunctionTwin,
        splitTopLevel,
        splitTopLevelWithRanges,
        parseFuncArgs,
        parseDimsParts,
        createHoverTypeAnalysisCache,
        createLazyCallContextOptions,
        isKnownFunctionName,
        finalizeDeclMatches,
        extractEnumSymbolName,
        isFunctionLikeDecl,
        resolveArgumentSymbolName: resolveArgumentSymbolName || hoverResolveArgumentSymbolName,
        getDeclMatchKey,
        applyHoverDisplayNameSuffixToMatches: applyHoverDisplayNameSuffixToMatches || hoverApplyHoverDisplayNameSuffixToMatches,
        buildCallArgLayout,
        expandObjectLikeDefineTupleCallArgs,
        isMeaningfulCallCursorPosition,
        isMeaningfulCallPosition,
        getHoverCacheSignature,
        logHover
    });

    const hoverFeature = createHoverFeature({
        vscode,
        refreshExtensionSettings,
        affectsAnyConfiguration,
        HOVER_RELEVANT_CONFIG_KEYS,
        getHoverMode,
        t,
        buildHoverAtPosition
    });

    return {
        hoverFeature,
        resolvePersistentHoverTarget,
        buildHoverAtPosition
    };
}

module.exports = { createHoverRuntimeFeature };
