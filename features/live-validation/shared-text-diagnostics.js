const { makeLiveValidationDiagnosticKey } = require('./diagnostic-key');
const { LIVE_INVALID_CODE_CHARACTER_DIAGNOSTIC_CODE } = require('./diagnostic-codes');
const { createTextSyntaxDiagnosticsCore } = require('../../core/syntax/text-diagnostics');
const {
    resolveLineStartOffset,
    splitPawnLines
} = require('../../core/syntax/lines');
const { isPreprocessorDirectiveLine } = require('../../core/syntax/preprocessor-lines');

function createSharedTextDiagnostics(deps) {
    const {
        vscode,
        t,
        isEscapedQuote,
        nonAsciiCharRe,
        isPawnIdentifierBoundaryChar
    } = deps;

    const {
        collectPawnLiteralIssues,
        collectPawnMultilineStringLiteralIssues,
        collectPackedStringDefaultLineFlags,
        collectInvalidPawnCodeCharacterRuns,
        getInputLineTooLongIssue,
        maskStringLiteralContent,
        findIdentifierRangesInLine,
        hasLineBreakInsideStringLiteral
    } = createTextSyntaxDiagnosticsCore({
        isEscapedQuote,
        nonAsciiCharRe,
        isPawnIdentifierBoundaryChar
    });



    function collectInvalidPawnCodeCharacterDiagnosticsForLine(document, lineNumber, lineText, strippedLineText, lineStartOffset, docLength, escapeChar = '', options = null) {
        const source = String(strippedLineText ?? lineText ?? '');
        const runs = collectInvalidPawnCodeCharacterRuns(source, escapeChar, options);
        const literalIssues = isPreprocessorDirectiveLine(source)
            ? []
            : collectPawnLiteralIssues(source, escapeChar, options);
        const lineTooLongIssue = getInputLineTooLongIssue(source);
        if (!runs.length && !literalIssues.length && !lineTooLongIssue) return [];

        const diagnostics = [];
        if (lineTooLongIssue) {
            diagnostics.push(createLiveValidationDiagnostic(
                createOffsetRange(
                    document,
                    lineStartOffset + lineTooLongIssue.start,
                    lineStartOffset + lineTooLongIssue.end,
                    docLength
                ),
                t('validation.inputLineTooLong')
            ));
        }
        for (const run of runs) {
            const diagnosticEnd = Math.max(run.start + 1, run.end);
            const diagnosticText = source.slice(run.start, diagnosticEnd) || run.text;
            const diagnostic = createLiveValidationDiagnostic(
                createOffsetRange(
                    document,
                    lineStartOffset + run.start,
                    lineStartOffset + diagnosticEnd,
                    docLength
                ),
                t('validation.invalidCodeCharacter', { chars: diagnosticText })
            );
            diagnostic.code = LIVE_INVALID_CODE_CHARACTER_DIAGNOSTIC_CODE;
            diagnostics.push(diagnostic);
        }
        for (const issue of literalIssues) {
            diagnostics.push(
                createLiveValidationDiagnostic(
                    createOffsetRange(
                        document,
                        lineStartOffset + issue.start,
                        lineStartOffset + issue.end,
                        docLength
                    ),
                    t(issue.messageKey)
                )
            );
        }
        return diagnostics;
    }



    function collectMultilinePawnStringLiteralDiagnostics(document, rootCtx, docLength, options = {}) {
        const lineStartOffsets = rootCtx.lineStartOffsets || null;
        const issues = collectPawnMultilineStringLiteralIssues(
            rootCtx.strippedLines || rootCtx.rawLines || splitPawnLines(rootCtx.text || ''),
            {
                lineCtrlChars: rootCtx.lineCtrlChars || options.lineCtrlChars || [],
                packedStringDefaultLineFlags: options.packedStringDefaultLineFlags || [],
                targetLineNumbers: options.targetLineNumbers || null
            }
        );
        if (!issues.length) return [];
        return issues.map(issue => {
            const lineStartOffset = resolveLineStartOffset(
                lineStartOffsets,
                issue.lineNumber,
                () => document.offsetAt(new vscode.Position(issue.lineNumber, 0))
            );
            return createLiveValidationDiagnostic(
                createOffsetRange(
                    document,
                    lineStartOffset + issue.start,
                    lineStartOffset + issue.end,
                    docLength
                ),
                t(issue.messageKey)
            );
        });
    }



    function createOffsetRange(document, startOffset, endOffset, docLength = null) {
        const safeDocLength = docLength ?? document.getText().length;
        const safeStart = Math.max(0, Math.min(safeDocLength, startOffset || 0));
        const safeEnd = Math.max(safeStart, Math.min(safeDocLength, endOffset || safeStart));
        const end = safeEnd > safeStart ? safeEnd : Math.min(safeDocLength, safeStart + 1);
        return new vscode.Range(document.positionAt(safeStart), document.positionAt(end));
    }



    function createLiveValidationDiagnostic(range, message, severity = null) {
        const diagnostic = new vscode.Diagnostic(
            range,
            String(message || 'Invalid AMXX Pawn syntax'),
            severity ?? vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = 'AMXX Pawn All-In';
        return diagnostic;
    }



    function getWarningSeverity() {
        return vscode.DiagnosticSeverity.Warning;
    }



    function getTypeCompatSeverity(status) {
        return status === 'warn'
            ? getWarningSeverity()
            : vscode.DiagnosticSeverity.Error;
    }



    function createIdentifierDiagnosticForOccurrence(document, lineStartOffset, lineText, name, occurrenceIndex, docLength, message) {
        const ranges = findIdentifierRangesInLine(lineText, name);
        const targetRange = ranges[Math.max(0, occurrenceIndex)] || ranges[ranges.length - 1] || null;
        if (!targetRange) return null;
        return createLiveValidationDiagnostic(
            createOffsetRange(
                document,
                lineStartOffset + targetRange.start,
                lineStartOffset + targetRange.end,
                docLength
            ),
            message
        );
    }



    return {
        collectInvalidPawnCodeCharacterRuns,
        collectPawnLiteralIssues,
        collectPawnMultilineStringLiteralIssues,
        collectPackedStringDefaultLineFlags,
        getInputLineTooLongIssue,
        collectInvalidPawnCodeCharacterDiagnosticsForLine,
        collectMultilinePawnStringLiteralDiagnostics,
        maskStringLiteralContent,
        createOffsetRange,
        createLiveValidationDiagnostic,
        getWarningSeverity,
        getTypeCompatSeverity,
        makeLiveValidationDiagnosticKey,
        createIdentifierDiagnosticForOccurrence,
        hasLineBreakInsideStringLiteral
    };
}

module.exports = { createSharedTextDiagnostics };
