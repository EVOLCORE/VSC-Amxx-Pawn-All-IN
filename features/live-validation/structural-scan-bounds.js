function getFullScanBounds(strippedLines) {
    return { start: 0, end: strippedLines.length - 1 };
}

function getStructuralScanBounds({ targetLines, strippedLines, functions, functionBodyRangeByLine }) {
    if (!(targetLines instanceof Set)) {
        return getFullScanBounds(strippedLines);
    }

    let first = Infinity;
    let last = -1;
    for (const line of targetLines) {
        if (!Number.isInteger(line)) continue;
        if (line < first) first = line;
        if (line > last) last = line;
    }
    if (!Number.isFinite(first) || last < first) {
        return getFullScanBounds(strippedLines);
    }

    const isContiguous = (last - first + 1) === targetLines.size;
    if (!isContiguous) {
        return getFullScanBounds(strippedLines);
    }
    if (first <= 0 && last >= strippedLines.length - 1) {
        return getFullScanBounds(strippedLines);
    }

    const matchesExpandedFunctionRange = (() => {
        for (const func of functions || []) {
            const functionStartLine = func.startLine ?? func.lineNumber ?? -1;
            if (functionStartLine !== first) continue;
            const headerEndLine = func.headerEndLine ?? functionStartLine;
            if (last < headerEndLine) continue;
            if (last === headerEndLine) return true;

            for (let probeLine = headerEndLine + 1; probeLine <= last; probeLine++) {
                const bodyRange = functionBodyRangeByLine[probeLine];
                if (bodyRange?.func === func && bodyRange.endLine === last) {
                    return true;
                }
            }
        }
        return false;
    })();

    return matchesExpandedFunctionRange
        ? { start: Math.max(0, first), end: Math.min(strippedLines.length - 1, last) }
        : getFullScanBounds(strippedLines);
}

module.exports = { getStructuralScanBounds };
