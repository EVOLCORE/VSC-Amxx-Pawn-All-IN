const { createDelimiterSyntaxCore } = require('../../core/syntax/delimiters');
const {
    buildLineStartOffsets,
    resolveLineStartOffset
} = require('../../core/syntax/lines');

function createDelimiterDiagnostics(deps) {
    const {
        createLiveValidationDiagnostic,
        createOffsetRange,
        isEscapedQuote,
        t,
        vscode
    } = deps;

    const {
        collectDelimiterBalanceIssues
    } = createDelimiterSyntaxCore({ isEscapedQuote });

    function getLineStartOffsets(document, rawLines, options) {
        if (options?.lineStartOffsets) return options.lineStartOffsets;
        if (typeof document?.getText === 'function') {
            return buildLineStartOffsets(document.getText());
        }
        const offsets = new Array(rawLines.length);
        for (let lineNumber = 0; lineNumber < rawLines.length; lineNumber++) {
            offsets[lineNumber] = document.offsetAt(new vscode.Position(lineNumber, 0));
        }
        return offsets;
    }

    function collectDelimiterBalanceState(document, rawLines, lineCtrlChars, docLength, targetLineNumbers = null, options = {}) {
        let lineStartOffsets = options?.lineStartOffsets || null;
        const getLineStartOffset = typeof options?.getLineStartOffset === 'function'
            ? options.getLineStartOffset
            : lineNumber => {
                if (!lineStartOffsets) {
                    lineStartOffsets = getLineStartOffsets(document, rawLines, options);
                }
                return resolveLineStartOffset(lineStartOffsets, lineNumber, 0);
            };
        const state = collectDelimiterBalanceIssues(
            rawLines,
            lineCtrlChars,
            targetLineNumbers,
            { lineStartOffsets, getLineStartOffset }
        );
        const diagnostics = (state.issues || []).map(issue =>
            createLiveValidationDiagnostic(
                createOffsetRange(document, issue.startOffset, issue.endOffset, docLength),
                t(issue.messageKey, issue.params || {})
            )
        );

        return {
            diagnostics,
            taintedLines: state.taintedLines
        };
    }

    return {
        collectDelimiterBalanceState
    };
}

module.exports = { createDelimiterDiagnostics };
