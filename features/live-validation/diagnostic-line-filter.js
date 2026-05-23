const {
    getDiagnosticEndLine,
    getDiagnosticLineSpan,
    getDiagnosticStartLine,
    getSingleLineDiagnosticRange,
    isSingleLineDiagnostic
} = require('../../core/diagnostics/ranges');

function createLiveDiagnosticLineFilter(options = {}) {
    const {
        isInactivePreprocessorLine = () => false,
        isDelimiterTaintedLine = () => false
    } = options;

    const shouldSkipLine = (lineNumber, filterOptions = {}) => {
        const {
            inactive = true,
            tainted = true
        } = filterOptions;
        if (!Number.isInteger(lineNumber) || lineNumber < 0) return false;
        if (inactive && isInactivePreprocessorLine(lineNumber)) return true;
        if (tainted && isDelimiterTaintedLine(lineNumber)) return true;
        return false;
    };

    const shouldSkipDiagnostic = (diagnostic, filterOptions = {}) =>
        shouldSkipLine(getDiagnosticStartLine(diagnostic), filterOptions);

    const shouldSkipInactiveLine = lineNumber => {
        if (!Number.isInteger(lineNumber) || lineNumber < 0) return false;
        return isInactivePreprocessorLine(lineNumber);
    };

    const shouldSkipTaintedLine = lineNumber => {
        if (!Number.isInteger(lineNumber) || lineNumber < 0) return false;
        return isDelimiterTaintedLine(lineNumber);
    };

    const shouldSkipInactiveDiagnostic = diagnostic =>
        shouldSkipInactiveLine(getDiagnosticStartLine(diagnostic));

    return {
        getDiagnosticStartLine,
        shouldSkipDiagnostic,
        shouldSkipInactiveDiagnostic,
        shouldSkipInactiveLine,
        shouldSkipTaintedLine,
        shouldSkipLine
    };
}

module.exports = {
    createLiveDiagnosticLineFilter,
    getDiagnosticEndLine,
    getDiagnosticLineSpan,
    getSingleLineDiagnosticRange,
    isSingleLineDiagnostic,
    getDiagnosticStartLine
};
