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

module.exports = { getPreprocessedCtrlCharState };
