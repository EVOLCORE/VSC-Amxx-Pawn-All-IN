const { resolveLineStartOffset } = require('./lines');

function createDelimiterSyntaxCore(deps) {
    const {
        isEscapedQuote
    } = deps;

    function collectDelimiterBalanceIssues(rawLines, lineCtrlChars, targetLineNumbers = null, options = {}) {
        const issues = [];
        const targetLines = targetLineNumbers instanceof Set ? targetLineNumbers : null;
        const stack = [];
        const taintedLines = new Uint8Array(rawLines.length);
        const lineStartOffsets = options?.lineStartOffsets || null;
        const getLineStartOffset = typeof options?.getLineStartOffset === 'function'
            ? options.getLineStartOffset
            : lineNumber => resolveLineStartOffset(lineStartOffsets, lineNumber, 0);
        const openToClose = { '(': ')', '[': ']', '{': '}' };
        const closeToOpen = { ')': '(', ']': '[', '}': '{' };
        const relevantLineRe = /[()[\]{}"'"]/;
        let inStr = false;
        let strCh = '';
        const lastStackEmptyCloseByChar = Object.create(null);

        const shouldIncludeLine = lineNumber => !targetLines || targetLines.has(lineNumber);
        const markTaintedRange = (startLine, endLine) => {
            const safeStart = Math.max(0, Math.min(rawLines.length - 1, startLine));
            const safeEnd = Math.max(safeStart, Math.min(rawLines.length - 1, endLine));
            for (let line = safeStart; line <= safeEnd; line++) {
                taintedLines[line] = 1;
            }
        };
        const pushIssue = (lineNumber, startOffset, endOffset, messageKey, params = {}) => {
            if (!shouldIncludeLine(lineNumber)) return;
            issues.push({ lineNumber, startOffset, endOffset, messageKey, params });
        };

        for (let lineNumber = 0; lineNumber < rawLines.length; lineNumber++) {
            const lineText = String(rawLines[lineNumber] || '');
            const escapeChar = lineCtrlChars[lineNumber];
            if (!inStr && !relevantLineRe.test(lineText)) {
                continue;
            }
            let lineStartOffset = -1;
            const currentLineStartOffset = () => {
                if (lineStartOffset < 0) lineStartOffset = getLineStartOffset(lineNumber);
                return lineStartOffset;
            };

            for (let index = 0; index < lineText.length; index++) {
                const char = lineText[index];
                if (inStr) {
                    if (char === strCh && !isEscapedQuote(lineText, index, escapeChar)) {
                        inStr = false;
                    }
                    continue;
                }
                if (char === '"' || char === "'") {
                    inStr = true;
                    strCh = char;
                    continue;
                }
                if (char === '(' || char === '[' || char === '{') {
                    stack.push({
                        char,
                        lineNumber,
                        index
                    });
                    continue;
                }
                if (char !== ')' && char !== ']' && char !== '}') continue;

                const expectedOpen = closeToOpen[char];
                const top = stack[stack.length - 1] || null;
                if (!top) {
                    const taintStartLine =
                        Number.isInteger(lastStackEmptyCloseByChar[char]?.lineNumber)
                            ? lastStackEmptyCloseByChar[char].lineNumber
                            : lineNumber;
                    markTaintedRange(taintStartLine, lineNumber);
                    pushIssue(
                        lineNumber,
                        currentLineStartOffset() + index,
                        currentLineStartOffset() + index + 1,
                        'validation.unmatchedClosingDelimiter',
                        { delimiter: char }
                    );
                    continue;
                }
                if (top.char !== expectedOpen) {
                    let matchingOpenIndex = -1;
                    for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex--) {
                        if (stack[stackIndex]?.char === expectedOpen) {
                            matchingOpenIndex = stackIndex;
                            break;
                        }
                    }
                    pushIssue(
                        lineNumber,
                        currentLineStartOffset() + index,
                        currentLineStartOffset() + index + 1,
                        matchingOpenIndex >= 0
                            ? 'validation.mismatchedClosingDelimiter'
                            : 'validation.unmatchedClosingDelimiter',
                        matchingOpenIndex >= 0
                            ? { expected: openToClose[top.char], actual: char }
                            : { delimiter: char }
                    );
                    markTaintedRange(top.lineNumber, lineNumber);
                    if (matchingOpenIndex >= 0) {
                        stack.splice(matchingOpenIndex, 1);
                    }
                    continue;
                }
                stack.pop();
                if (!stack.length) {
                    lastStackEmptyCloseByChar[char] = {
                        lineNumber
                    };
                }
            }
        }

        for (const unclosed of stack) {
            const offset = getLineStartOffset(unclosed.lineNumber) + unclosed.index;
            markTaintedRange(unclosed.lineNumber, rawLines.length - 1);
            pushIssue(
                unclosed.lineNumber,
                offset,
                offset + 1,
                'validation.unclosedOpeningDelimiter',
                { delimiter: unclosed.char }
            );
        }

        return {
            issues,
            taintedLines
        };
    }

    return {
        collectDelimiterBalanceIssues
    };
}

module.exports = { createDelimiterSyntaxCore };
