function getDiagnosticStartLine(diagnostic) {
    const lineNumber = diagnostic?.range?.start?.line;
    return Number.isInteger(lineNumber) ? lineNumber : -1;
}

function getDiagnosticEndLine(diagnostic) {
    const lineNumber = diagnostic?.range?.end?.line;
    return Number.isInteger(lineNumber) ? lineNumber : -1;
}

function getDiagnosticLineSpan(diagnostic) {
    const startLine = getDiagnosticStartLine(diagnostic);
    if (startLine < 0) return null;
    const endLine = getDiagnosticEndLine(diagnostic);
    return {
        startLine,
        endLine: endLine >= startLine ? endLine : startLine
    };
}

function isSingleLineDiagnostic(diagnostic) {
    const span = getDiagnosticLineSpan(diagnostic);
    return !!span && span.startLine === span.endLine;
}

function getSingleLineDiagnosticRange(diagnostic) {
    const range = diagnostic?.range || null;
    if (!range?.start || !range?.end) return null;
    const startLine = getDiagnosticStartLine(diagnostic);
    const endLine = getDiagnosticEndLine(diagnostic);
    if (startLine < 0 || startLine !== endLine) return null;
    return range;
}

function doesDiagnosticOverlapLine(diagnostic, lineNumber) {
    if (!Number.isInteger(lineNumber) || lineNumber < 0) return false;
    const span = getDiagnosticLineSpan(diagnostic);
    return !!span && span.startLine <= lineNumber && span.endLine >= lineNumber;
}

function doesDiagnosticOverlapLineRange(diagnostic, lineRange = null) {
    const startLine = lineRange?.startLine;
    const endLine = lineRange?.endLine;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return false;
    const span = getDiagnosticLineSpan(diagnostic);
    return !!span && span.endLine >= startLine && span.startLine <= endLine;
}

module.exports = {
    doesDiagnosticOverlapLine,
    doesDiagnosticOverlapLineRange,
    getDiagnosticEndLine,
    getDiagnosticLineSpan,
    getDiagnosticStartLine,
    getSingleLineDiagnosticRange,
    isSingleLineDiagnostic
};
