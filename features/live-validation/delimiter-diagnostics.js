const { createDelimiterSyntaxCore } = require('../../core/syntax');
const { buildLineStartOffsets } = require('../../core/syntax/lines');

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
        const lineStartOffsets = getLineStartOffsets(document, rawLines, options);
        const state = collectDelimiterBalanceIssues(
            rawLines,
            lineCtrlChars,
            targetLineNumbers,
            { lineStartOffsets }
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
