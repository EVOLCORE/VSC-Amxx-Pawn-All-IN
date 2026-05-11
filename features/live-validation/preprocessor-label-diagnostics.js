const { createPreprocessorLabelSyntaxCore } = require('../../core/syntax');
const { LIVE_UNRESOLVED_INCLUDE_DIAGNOSTIC_CODE } = require('./diagnostic-codes');

function createPreprocessorLabelDiagnostics(deps) {
    const {
        areWarningDiagnosticsEnabled,
        createLiveValidationDiagnostic,
        createOffsetRange,
        getMacroRedefinitionIssue,
        getNestedCommentIssue,
        getInvalidRationalPrecisionIssue,
        collectDeclaredTagNames,
        collectTagOverrideParenthesesIssues,
        getFunctionBodyRangeByLine,
        getLabelDeclarationIssues,
        getRationalFormatAlreadyDefinedIssue,
        getSymbolTruncationIssue,
        collectRationalLiteralIssues,
        collectRationalLiteralPrecisionIssues,
        createRationalStateFromPragma,
        getUnknownPragmaIssue,
        getWarningSeverity,
        ignoredUnknownSymbolNames,
        isEnumMemberDeclarationLine,
        isFunctionHeaderLine,
        parseLabelDeclaration,
        parsePreprocessorDefineDirective,
        parsePreprocessorDirectiveLine,
        collectPreprocessorDirectiveText,
        parseRationalPragmaPayload,
        collectGotoReferences,
        collectEnumMemberSyntaxIssues,
        analyzePreprocessorConditionExpression,
        getPreprocessorDirectiveIssues,
        isIncludeDocument,
        isStrictIncludeValidationEnabled,
        maskStringLiteralContent,
        stripLeadingInlineStatementPrefix,
        t,
        vscode
    } = deps;

    const {
        collectPreprocessorAndLabelIssues
    } = createPreprocessorLabelSyntaxCore({
        getMacroRedefinitionIssue,
        getNestedCommentIssue,
        getInvalidRationalPrecisionIssue,
        collectDeclaredTagNames,
        collectTagOverrideParenthesesIssues,
        getFunctionBodyRangeByLine,
        getLabelDeclarationIssues,
        getRationalFormatAlreadyDefinedIssue,
        getSymbolTruncationIssue,
        collectRationalLiteralIssues,
        collectRationalLiteralPrecisionIssues,
        createRationalStateFromPragma,
        getUnknownPragmaIssue,
        ignoredUnknownSymbolNames,
        isEnumMemberDeclarationLine,
        isFunctionHeaderLine,
        parseLabelDeclaration,
        parsePreprocessorDefineDirective,
        parsePreprocessorDirectiveLine,
        collectPreprocessorDirectiveText,
        parseRationalPragmaPayload,
        collectGotoReferences,
        collectEnumMemberSyntaxIssues,
        analyzePreprocessorConditionExpression,
        getPreprocessorDirectiveIssues,
        maskStringLiteralContent,
        stripLeadingInlineStatementPrefix
    });

    function collectPreprocessorAndLabelLiveDiagnostics(document, rootCtx, docLength, targetLineNumbers = null) {
        if (isIncludeDocument(document) && !isStrictIncludeValidationEnabled()) {
            return [];
        }
        const lineStartOffsets = rootCtx.lineStartOffsets || null;
        const createLineRange = (lineNumber, startIndex, length) => {
            const lineStartOffset = lineStartOffsets?.[lineNumber] ??
                document.offsetAt(new vscode.Position(lineNumber, 0));
            return createOffsetRange(
                document,
                lineStartOffset + Math.max(0, startIndex),
                lineStartOffset + Math.max(length, startIndex + length),
                docLength
            );
        };

        return collectPreprocessorAndLabelIssues(rootCtx, targetLineNumbers, {
            includeWarnings: areWarningDiagnosticsEnabled()
        }).map(issue => {
            const diagnostic = createLiveValidationDiagnostic(
                createLineRange(issue.lineNumber, issue.startIndex, issue.length),
                t(issue.messageKey, issue.params || {}),
                issue.severity === 'warning' ? getWarningSeverity() : undefined
            );
            if (
                issue.messageKey === 'validation.includeNotResolved' ||
                issue.messageKey === 'validation.includeDependencyNotResolved'
            ) {
                diagnostic.code = LIVE_UNRESOLVED_INCLUDE_DIAGNOSTIC_CODE;
            }
            return diagnostic;
        });
    }

    return {
        collectPreprocessorAndLabelLiveDiagnostics
    };
}

module.exports = { createPreprocessorLabelDiagnostics };
