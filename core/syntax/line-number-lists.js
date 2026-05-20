function isValidLineNumber(lineNumber, lineCount) {
    return Number.isInteger(lineNumber) && lineNumber >= 0 && lineNumber < lineCount;
}

function mergeSortedUniqueLineNumbers(lineCount, leftLines = [], rightLines = []) {
    const safeLineCount = Math.max(0, lineCount | 0);
    const left = Array.isArray(leftLines) ? leftLines : [];
    const right = Array.isArray(rightLines) ? rightLines : [];
    const merged = [];
    let leftIndex = 0;
    let rightIndex = 0;
    let previousLine = -1;

    while (leftIndex < left.length || rightIndex < right.length) {
        let lineNumber;
        if (
            rightIndex >= right.length ||
            (
                leftIndex < left.length &&
                left[leftIndex] <= right[rightIndex]
            )
        ) {
            lineNumber = left[leftIndex++];
        } else {
            lineNumber = right[rightIndex++];
        }
        if (!isValidLineNumber(lineNumber, safeLineCount) || lineNumber === previousLine) continue;
        previousLine = lineNumber;
        merged.push(lineNumber);
    }

    return merged;
}

function toSortedUniqueLineNumbers(lineCount, lines = []) {
    const safeLineCount = Math.max(0, lineCount | 0);
    if (!safeLineCount) return [];
    const flags = new Uint8Array(safeLineCount);
    const result = [];
    for (const lineNumber of lines || []) {
        if (!isValidLineNumber(lineNumber, safeLineCount) || flags[lineNumber]) continue;
        flags[lineNumber] = 1;
        result.push(lineNumber);
    }
    result.sort((left, right) => left - right);
    return result;
}

function sortUniqueLineNumbers(lines = []) {
    const seen = new Set();
    const result = [];
    for (const lineNumber of lines || []) {
        if (!Number.isInteger(lineNumber) || lineNumber < 0 || seen.has(lineNumber)) continue;
        seen.add(lineNumber);
        result.push(lineNumber);
    }
    result.sort((left, right) => left - right);
    return result;
}

function createLineNumberFlags(lineCount, lines = []) {
    const safeLineCount = Math.max(0, lineCount | 0);
    const flags = new Uint8Array(safeLineCount);
    for (const lineNumber of lines || []) {
        if (isValidLineNumber(lineNumber, safeLineCount)) flags[lineNumber] = 1;
    }
    return flags;
}

module.exports = {
    createLineNumberFlags,
    isValidLineNumber,
    mergeSortedUniqueLineNumbers,
    sortUniqueLineNumbers,
    toSortedUniqueLineNumbers
};
