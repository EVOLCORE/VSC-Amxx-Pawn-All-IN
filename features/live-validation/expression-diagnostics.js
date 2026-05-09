function createExpressionDiagnostics(deps) {
    const {
        createLiveValidationDiagnostic,
        createOffsetRange,
        findPossiblyUnintendedBitwiseOperationIssues,
        findSizeofOperatorIssues,
        isIncludeDocument,
        isStrictIncludeValidationEnabled,
        t
    } = deps;

    function collectExpressionOperatorLiveDiagnosticsForLine(document, lineNumber, ctx, lineText, strippedLineText, lineStartOffset, docLength) {
        const diagnostics = [];
        if (isIncludeDocument(document) && !isStrictIncludeValidationEnabled()) return diagnostics;
        const source = String(strippedLineText || lineText || '');
        const trimmed = source.trim();
        if (!trimmed || trimmed.startsWith('#')) return diagnostics;

        for (const issue of findSizeofOperatorIssues(source, ctx)) {
            const message = issue.kind === 'indeterminateArraySize'
                ? t('validation.indeterminateArraySizeInSizeof', { name: issue.name || '' })
                : t('validation.sizeofFunctionInvalid');
            diagnostics.push(
                createLiveValidationDiagnostic(
                    createOffsetRange(
                        document,
                        lineStartOffset + issue.start,
                        lineStartOffset + issue.end,
                        docLength
                    ),
                    message,
                    issue.severity
                )
            );
        }

        for (const issue of findPossiblyUnintendedBitwiseOperationIssues(source)) {
            diagnostics.push(
                createLiveValidationDiagnostic(
                    createOffsetRange(
                        document,
                        lineStartOffset + issue.start,
                        lineStartOffset + issue.end,
                        docLength
                    ),
                    t('validation.possiblyUnintendedBitwiseOperation'),
                    issue.severity
                )
            );
        }

        return diagnostics;
    }

    return {
        collectExpressionOperatorLiveDiagnosticsForLine
    };
}

module.exports = { createExpressionDiagnostics };
