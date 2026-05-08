const { createPreprocessorLabelSyntaxCore } = require('../../core/syntax');

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
        analyzePreprocessorConditionExpression,
        getPreprocessorDirectiveIssues,
        maskStringLiteralContent,
        stripLeadingInlineStatementPrefix
    });

    function collectPreprocessorAndLabelLiveDiagnostics(document, rootCtx, docLength, targetLineNumbers = null) {
        if (isIncludeDocument?.(document) && !isStrictIncludeValidationEnabled?.()) {
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
            includeWarnings: areWarningDiagnosticsEnabled?.()
        }).map(issue =>
            createLiveValidationDiagnostic(
                createLineRange(issue.lineNumber, issue.startIndex, issue.length),
                t(issue.messageKey, issue.params || {}),
                issue.severity === 'warning' ? getWarningSeverity?.() : undefined
            )
        );
    }

    return {
        collectPreprocessorAndLabelLiveDiagnostics
    };
}

module.exports = { createPreprocessorLabelDiagnostics };
