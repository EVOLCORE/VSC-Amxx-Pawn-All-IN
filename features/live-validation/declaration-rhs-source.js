function createDeclarationRhsSourceReader({ isEscapedQuote }) {
    function getAssignmentRhsSourceInfo(ctx, lineText, lineStartOffset, rhsStartInLine, fallbackText, escapeChar) {
        const sourceText = String(ctx?.text || '');
        const fallback = String(fallbackText || '').trim();
        const fallbackStartOffset = lineStartOffset + Math.max(0, rhsStartInLine);
        const fallbackEndOffset = fallbackStartOffset + fallback.length;
        if (!sourceText || fallbackStartOffset < 0 || fallbackStartOffset >= sourceText.length) {
            return { text: fallback, startOffset: fallbackStartOffset, endOffset: fallbackEndOffset };
        }

        const firstLineEndOffset = lineStartOffset + String(lineText || '').length;
        const firstLineSource = sourceText.slice(fallbackStartOffset, firstLineEndOffset);
        if (
            !firstLineSource.includes('(') &&
            !firstLineSource.includes('[') &&
            !firstLineSource.includes('{')
        ) {
            return { text: fallback, startOffset: fallbackStartOffset, endOffset: fallbackEndOffset };
        }

        const expectedClosers = [];
        let inString = false;
        let stringChar = '';
        let lineComment = false;
        let blockComment = false;
        let lastNonWhitespace = fallbackStartOffset - 1;
        let sawOpenGroup = false;

        const isQuoteEscaped = index => isEscapedQuote(sourceText, index, escapeChar);

        for (let index = fallbackStartOffset; index < sourceText.length; index++) {
            const char = sourceText[index];
            const next = sourceText[index + 1] || '';

            if (blockComment) {
                if (char === '*' && next === '/') {
                    blockComment = false;
                    index++;
                }
                continue;
            }
            if (lineComment) {
                if (char === '\n') {
                    lineComment = false;
                    if (!expectedClosers.length) break;
                }
                continue;
            }
            if (inString) {
                if (char === stringChar && !isQuoteEscaped(index)) {
                    inString = false;
                }
                if (!/\s/.test(char)) lastNonWhitespace = index;
                continue;
            }

            if (char === '/' && next === '/') {
                lineComment = true;
                index++;
                if (!expectedClosers.length) break;
                continue;
            }
            if (char === '/' && next === '*') {
                blockComment = true;
                index++;
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                lastNonWhitespace = index;
                continue;
            }
            if (char === '(') {
                expectedClosers.push(')');
                sawOpenGroup = true;
                lastNonWhitespace = index;
                continue;
            }
            if (char === '[') {
                expectedClosers.push(']');
                sawOpenGroup = true;
                lastNonWhitespace = index;
                continue;
            }
            if (char === '{') {
                expectedClosers.push('}');
                sawOpenGroup = true;
                lastNonWhitespace = index;
                continue;
            }
            if (char === ')' || char === ']' || char === '}') {
                if (expectedClosers[expectedClosers.length - 1] === char) {
                    expectedClosers.pop();
                }
                lastNonWhitespace = index;
                continue;
            }
            if ((char === '\r' || char === '\n' || char === ';') && !expectedClosers.length) {
                break;
            }
            if (!/\s/.test(char)) {
                lastNonWhitespace = index;
            }
        }

        if (!sawOpenGroup || lastNonWhitespace < fallbackStartOffset) {
            return { text: fallback, startOffset: fallbackStartOffset, endOffset: fallbackEndOffset };
        }

        const endOffset = Math.max(fallbackStartOffset, lastNonWhitespace + 1);
        const text = sourceText.slice(fallbackStartOffset, endOffset).trim();
        return { text, startOffset: fallbackStartOffset, endOffset };
    }

    return { getAssignmentRhsSourceInfo };
}

module.exports = { createDeclarationRhsSourceReader };
