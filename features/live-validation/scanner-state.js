function createScannerLineState({
    document,
    rootCtx,
    documentScanPlan,
    collectIndexedAccessExpressionsFromLine,
    collectInlineNamedCallContexts
}) {
    const lineSnapshotCache = [];
    let lineStartOffsets = rootCtx.semanticSession?.lineStartOffsets || null;

    const getLineStartOffsets = () => {
        if (lineStartOffsets) return lineStartOffsets;
        lineStartOffsets = rootCtx.lineStartOffsets;
        if (!lineStartOffsets) {
            const starts = [0];
            const text = String(rootCtx.text || '');
            for (let index = 0; index < text.length; index++) {
                if (text.charCodeAt(index) === 10) {
                    starts.push(index + 1);
                }
            }
            lineStartOffsets = starts;
        }
        if (rootCtx.semanticSession) {
            rootCtx.semanticSession.lineStartOffsets = lineStartOffsets;
        }
        return lineStartOffsets;
    };

    const getValidationLineStartOffset = lineNumber => getLineStartOffsets()[lineNumber] ?? 0;

    const getValidationLineSnapshot = lineNumber => {
        const cachedSnapshot = lineSnapshotCache[lineNumber];
        if (cachedSnapshot !== undefined) return cachedSnapshot;
        const text = documentScanPlan.rawLines[lineNumber] ?? document.lineAt(lineNumber).text;
        const startOffset = getValidationLineStartOffset(lineNumber);
        const snapshot = { text, startOffset };
        lineSnapshotCache[lineNumber] = snapshot;
        return snapshot;
    };

    const getIndexedExpressionsForLine = (lineNumber, strippedLineText) => {
        const cachedIndexedExpressions = documentScanPlan.indexedExpressionsByLine[lineNumber];
        if (cachedIndexedExpressions !== undefined) return cachedIndexedExpressions;
        const escapeChar = rootCtx.resolver.ctrlCharAtLine(lineNumber);
        const indexedExpressions = collectIndexedAccessExpressionsFromLine(strippedLineText, escapeChar);
        documentScanPlan.indexedExpressionsByLine[lineNumber] = indexedExpressions;
        return indexedExpressions;
    };

    const getInlineCallsForLine = (lineNumber, strippedLineText, lineStartOffset) => {
        const cachedInlineCalls = documentScanPlan.inlineCallsByLine[lineNumber];
        if (cachedInlineCalls !== undefined) return cachedInlineCalls;
        const escapeChar = rootCtx.resolver.ctrlCharAtLine(lineNumber);
        const inlineCalls = collectInlineNamedCallContexts(strippedLineText, lineStartOffset, escapeChar, {
            includeClosedCalls: true
        });
        documentScanPlan.inlineCallsByLine[lineNumber] = inlineCalls;
        return inlineCalls;
    };

    return {
        getLineStartOffsets,
        getValidationLineSnapshot,
        getIndexedExpressionsForLine,
        getInlineCallsForLine
    };
}

module.exports = { createScannerLineState };
