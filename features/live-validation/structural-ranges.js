function createStructuralRangeHelpers({ document, docLength, rawLines, getLineStartOffset, createOffsetRange }) {
    const createKeywordRange = (lineNumber, keyword, fallbackIndex = -1) => {
        const lineText = rawLines[lineNumber] || '';
        const keywordIndex = fallbackIndex >= 0 ? fallbackIndex : lineText.indexOf(keyword);
        const lineStartOffset = getLineStartOffset(lineNumber);
        return createOffsetRange(
            document,
            lineStartOffset + Math.max(0, keywordIndex),
            lineStartOffset + Math.max(keyword.length, keywordIndex + keyword.length),
            docLength
        );
    };

    const createSwitchCaseLabelRange = (lineNumber, switchLabel) => {
        const labelStart = Number.isInteger(switchLabel?.labelStart)
            ? switchLabel.labelStart
            : -1;
        const labelEnd = Number.isInteger(switchLabel?.labelEnd)
            ? switchLabel.labelEnd
            : -1;
        if (labelStart >= 0 && labelEnd > labelStart) {
            const lineStartOffset = getLineStartOffset(lineNumber);
            return createOffsetRange(
                document,
                lineStartOffset + labelStart,
                lineStartOffset + labelEnd,
                docLength
            );
        }
        return createKeywordRange(lineNumber, 'case', switchLabel?.keywordStart ?? -1);
    };

    const createFunctionNameRange = functionDecl => {
        const lineNumber = functionDecl?.startLine ?? functionDecl?.lineNumber ?? 0;
        const lineText = rawLines[lineNumber] || '';
        const name = String(functionDecl?.name || '');
        const nameIndex = name ? lineText.indexOf(name) : -1;
        const lineStartOffset = getLineStartOffset(lineNumber);
        return createOffsetRange(
            document,
            lineStartOffset + Math.max(0, nameIndex),
            lineStartOffset + Math.max(1, nameIndex >= 0 ? nameIndex + name.length : lineText.length),
            docLength
        );
    };

    return {
        createFunctionNameRange,
        createKeywordRange,
        createSwitchCaseLabelRange
    };
}

module.exports = { createStructuralRangeHelpers };
