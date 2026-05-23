const {
    createDeclarationGuardsCore
} = require('../../core/declarations/runtime');
const {
    createDeclarationParsingCore
} = require('../../core/declarations/parsing');
const { createValidationCore } = require('../../core/validation/runtime');
const { createCallAnalysisCore } = require('../../core/call-analysis/runtime');
const { createIndexedAccessCore } = require('../../core/indexed-access/runtime');
const { createStatementClassifier } = require('../../core/syntax/statement-classifier');

function createAnalysisRuntime(deps) {
    const {
        vscode,
        fs,
        t,
        normalizeFsPath,
        getActiveCtrlChar,
        isEscapedQuote,
        measurePawnStringLiteral,
        splitTopLevel,
        splitTopLevelWithRanges,
        escapeRegExp,
        unwrapOuterParens,
        parseTopLevelTernaryExpression,
        looksLikePawnExpressionFragment,
        extractEnumSymbolName,
        findDeclByNameCached,
        getDeclNameBuckets,
        isFunctionLikeDecl,
        BUILTIN_DECLS,
        FORBIDDEN,
        TAG_RE,
        MOD_RE,
        NAME_RE,
        VAR_MODS,
        getLookupTokenAtPosition,
        findDefinitionContext,
        collectDeclarationText,
        collectForHeaderText,
        getCtrlCharStateForContent,
        withCtrlCharForContent,
        stripLineComment,
        stripCommentsFromLines,
        extractParenContent,
        parseEnumHeaderSpec,
        formatAutoEnumValueDisplay,
        formatResolvedEnumValueDisplay,
        applyEnumStep,
        extractDocs,
        parseDims,
        parseValueAndRemainder,
        parsePreprocessorDirectiveLine,
        parsePreprocessorSingleIdentifierPayload,
        parsePreprocessorDefineDirective,
        parseFunctionStateSpecTail,
        computeLineDepths,
        preprocessPawnContent,
        buildDependencyStampMap,
        areDependencyStampsFresh,
        fileDeclParseCache,
        getFileSnapshot,
        isObjectLikeDefineDecl,
        isFunctionLikeDefineDecl,
        parseSingleStatementBodyDecls,
        findStatementScopeEndLine,
        findForScopeEndLine,
        findDepthScopeEndLine,
        getFuncArgsParseCacheKey,
        funcArgsParseCache,
        getDocumentTextAndResolver,
        isKnownFunctionName,
        collectRationalLiteralIssues
    } = deps;

    const validationRuntime = createValidationCore({
        vscode,
        fs,
        t,
        getActiveCtrlChar,
        isEscapedQuote,
        measurePawnStringLiteral,
        splitTopLevel,
        escapeRegExp,
        unwrapOuterParens,
        extractEnumSymbolName,
        findDeclByNameCached,
        getDeclNameBuckets,
        isFunctionLikeDecl,
        BUILTIN_DECLS,
        FORBIDDEN,
        TAG_RE,
        isPawnIdentifierStartChar: deps.isPawnIdentifierStartChar,
        isPawnIdentifierContinueChar: deps.isPawnIdentifierContinueChar
    });
    const statementClassifierRuntime = createStatementClassifier({
        isEscapedQuote,
        isIdentifierStartChar: validationRuntime.isIdentifierStartChar,
        isIdentifierContinueChar: validationRuntime.isIdentifierContinueChar,
        findFirstNonWhitespaceIndex: validationRuntime.findFirstNonWhitespaceIndex,
        findBalancedGroupEnd: validationRuntime.findBalancedGroupEnd,
        stripTrailingSemicolon: validationRuntime.stripTrailingSemicolon,
        splitTopLevel,
        evaluatePawnNumericExpr: validationRuntime.evaluatePawnNumericExpr,
        looksLikePawnExpressionFragment
    });

    const callAnalysisRuntime = createCallAnalysisCore({
        vscode,
        t,
        escapeRegExp,
        isIdentifierStartChar: validationRuntime.isIdentifierStartChar,
        isIdentifierContinueChar: validationRuntime.isIdentifierContinueChar,
        parseParamMeta: validationRuntime.parseParamMeta,
        isVariadicParam: deps.isVariadicParam,
        inferArgType: validationRuntime.inferArgType,
        inferArrayShapeActualType: validationRuntime.inferArrayShapeActualType,
        getExpressionAssignableInfo: validationRuntime.getExpressionAssignableInfo,
        findArrayMustBeIndexedIssue: validationRuntime.findArrayMustBeIndexedIssue,
        explainTypeCompat: validationRuntime.explainTypeCompat,
        explainParamDeclCompat: validationRuntime.explainParamDeclCompat,
        getArrayShapeIssue: validationRuntime.getArrayShapeIssue,
        explainArrayShapeDiagnosticIssue: validationRuntime.explainArrayShapeDiagnosticIssue,
        isEscapedQuote,
        FORBIDDEN,
        withCtrlCharForContent,
        getActiveCtrlChar,
        splitTopLevel,
        splitTopLevelWithRanges,
        isFunctionLikeDecl,
        getDocumentTextAndResolver,
        isKnownFunctionName,
        collectRationalLiteralIssues
    });

    const declarationGuardsRuntime = createDeclarationGuardsCore({
        vscode,
        escapeRegExp,
        getLookupTokenAtPosition,
        findDefinitionContext: callAnalysisRuntime.findDefinitionContext,
        collectDeclarationText,
        getCtrlCharStateForContent,
        parseOperatorOverloadToken: validationRuntime.parseOperatorOverloadToken
    });

    const declarationParsingRuntime = createDeclarationParsingCore({
        normalizeFsPath,
        getFuncArgsParseCacheKey,
        funcArgsParseCache,
        getActiveCtrlChar,
        splitTopLevel,
        isEscapedQuote,
        extractParenContent,
        stripLineComment,
        stripCommentsFromLines,
        parseEnumHeaderSpec,
        parseDimsParts: validationRuntime.parseDimsParts,
        parseDimSpec: validationRuntime.parseDimSpec,
        evaluatePawnNumericExpr: validationRuntime.evaluatePawnNumericExpr,
        formatAutoEnumValueDisplay,
        formatResolvedEnumValueDisplay,
        applyEnumStep,
        escapeRegExp,
        extractDocs,
        FORBIDDEN,
        TAG_RE,
        NAME_RE,
        MOD_RE,
        VAR_MODS,
        parseDims,
        parseValueAndRemainder,
        parsePreprocessorDirectiveLine,
        parsePreprocessorSingleIdentifierPayload,
        parsePreprocessorDefineDirective,
        parseFunctionStateSpecTail,
        computeLineDepths,
        collectDeclarationText,
        collectForHeaderText,
        withCtrlCharForContent,
        getCtrlCharStateForContent,
        preprocessPawnContent,
        buildDependencyStampMap,
        areDependencyStampsFresh,
        fileDeclParseCache,
        getFileSnapshot,
        isObjectLikeDefineDecl,
        isFunctionLikeDefineDecl,
        parseSingleStatementBodyDecls,
        findStatementScopeEndLine,
        findForScopeEndLine,
        findDepthScopeEndLine
    });

    const indexedAccessRuntime = createIndexedAccessCore({
        t,
        getActiveCtrlChar,
        getLookupTokenAtPosition,
        getCtrlCharStateForContent,
        isEscapedQuote,
        collectDeclarationText,
        extractEnumSymbolName,
        inferArgType: validationRuntime.inferArgType,
        parseTopLevelTernaryExpression,
        parseDimSpec: validationRuntime.parseDimSpec,
        normalizeEnumName: validationRuntime.normalizeEnumName,
        getEnumItemCellSpan: validationRuntime.getEnumItemCellSpan,
        findUnresolvedReferenceNames: validationRuntime.findUnresolvedReferenceNames,
        evaluatePawnNumericExpr: validationRuntime.evaluatePawnNumericExpr
    });

    return {
        ...validationRuntime,
        ...statementClassifierRuntime,
        ...callAnalysisRuntime,
        ...declarationGuardsRuntime,
        ...declarationParsingRuntime,
        ...indexedAccessRuntime
    };
}

module.exports = { createAnalysisRuntime };
