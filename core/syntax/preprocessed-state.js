const { splitPawnLines } = require('./lines');

function getPreprocessedCtrlCharState(preprocessedState) {
    if (!preprocessedState || typeof preprocessedState !== 'object') return null;
    if (!Array.isArray(preprocessedState.rawLines)) return null;
    if (!Array.isArray(preprocessedState.strippedLines)) return null;
    if (!Array.isArray(preprocessedState.lineCtrlChars)) return null;
    return {
        rawLines: preprocessedState.rawLines,
        strippedLines: preprocessedState.strippedLines,
        lineCtrlChars: preprocessedState.lineCtrlChars,
        directiveCandidateLines: Array.isArray(preprocessedState.directiveCandidateLines)
            ? preprocessedState.directiveCandidateLines
            : [],
        finalCtrlChar: preprocessedState.finalCtrlChar || '^'
    };
}

function getSemanticScanLines(sourceState, options = {}) {
    const rawLines = Array.isArray(options.rawLines)
        ? options.rawLines
        : (Array.isArray(sourceState?.rawLines)
            ? sourceState.rawLines
            : splitPawnLines(sourceState?.text || options.text || ''));
    const preprocessedState = sourceState?.preprocessedState || null;
    const preprocessedStrippedLines = Array.isArray(preprocessedState?.strippedLines)
        ? preprocessedState.strippedLines
        : [];
    if (preprocessedStrippedLines.length === rawLines.length) {
        return preprocessedStrippedLines;
    }

    const strippedLines = Array.isArray(sourceState?.strippedLines)
        ? sourceState.strippedLines
        : [];
    if (strippedLines.length === rawLines.length) {
        return strippedLines;
    }

    const preprocessedRawLines = Array.isArray(preprocessedState?.rawLines)
        ? preprocessedState.rawLines
        : splitPawnLines(preprocessedState?.content || '');
    if (preprocessedRawLines.length === rawLines.length) {
        return preprocessedRawLines;
    }

    return rawLines;
}

module.exports = {
    getPreprocessedCtrlCharState,
    getSemanticScanLines
};
