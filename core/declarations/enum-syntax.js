const {
    countLineBreaks,
    isPawnIdentifierContinueCode,
    isPawnIdentifierStartCode,
    isPotentialEnumDeclarationLine,
    isWhitespaceCharCode
} = require('./line-utils');
const { maskPreprocessorDirectiveLines } = require('../syntax/preprocessor-lines');

function createEnumSyntaxDiagnosticsCore(deps) {
    const {
        FORBIDDEN,
        getActiveCtrlChar,
        isEscapedQuote,
        stripLineComment
    } = deps;

    function splitTopLevelWithOffsets(source) {
        if (!String(source || '').trim()) return [];
        const parts = [];
        const escapeChar = getActiveCtrlChar();
        let depth = 0;
        let inStr = false;
        let strCh = '';
        let startOffset = 0;
        let startLineOffset = 0;
        let lineOffset = 0;
        const pushPart = endOffset => {
            let trimStart = startOffset;
            let trimStartLineOffset = startLineOffset;
            while (trimStart < endOffset && isWhitespaceCharCode(source.charCodeAt(trimStart))) {
                if (source[trimStart] === '\n') trimStartLineOffset++;
                trimStart++;
            }
            let trimEnd = endOffset;
            while (trimEnd > trimStart && isWhitespaceCharCode(source.charCodeAt(trimEnd - 1))) {
                trimEnd--;
            }
            if (trimStart < trimEnd) {
                parts.push({
                    text: source.slice(trimStart, trimEnd),
                    startOffset: trimStart,
                    startLineOffset: trimStartLineOffset
                });
            }
            startOffset = endOffset + 1;
            startLineOffset = lineOffset;
        };
        for (let index = 0; index < source.length; index++) {
            const char = source[index];
            if (char === '\n') {
                lineOffset++;
            }
            if (inStr) {
                if (char === strCh && !isEscapedQuote(source, index, escapeChar)) {
                    inStr = false;
                }
                continue;
            }
            if (char === '"' || char === "'") {
                inStr = true;
                strCh = char;
                continue;
            }
            if (char === '[' || char === '(' || char === '{') depth++;
            else if (char === ']' || char === ')' || char === '}') depth--;
            else if (char === ',' && depth === 0) {
                pushPart(index);
            }
        }
        pushPart(source.length);
        return parts;
    }

    function parseEnumMemberPrefix(source, baseOffset = 0) {
        const piece = String(source || '');
        let cursor = 0;
        while (cursor < piece.length && isWhitespaceCharCode(piece.charCodeAt(cursor))) cursor++;
        if (cursor >= piece.length) return null;

        let typeTag = '';
        const tagStart = cursor;
        const firstCode = piece.charCodeAt(cursor);
        if (firstCode === 123) {
            const closeBrace = piece.indexOf('}', cursor + 1);
            if (closeBrace > cursor) {
                let colonProbe = closeBrace + 1;
                while (colonProbe < piece.length && isWhitespaceCharCode(piece.charCodeAt(colonProbe))) colonProbe++;
                if (piece.charCodeAt(colonProbe) === 58) {
                    typeTag = piece.slice(cursor, closeBrace + 1);
                    cursor = colonProbe + 1;
                }
            }
        } else if (isPawnIdentifierStartCode(firstCode)) {
            let tagEnd = cursor + 1;
            while (tagEnd < piece.length && isPawnIdentifierContinueCode(piece.charCodeAt(tagEnd))) tagEnd++;
            let colonProbe = tagEnd;
            while (colonProbe < piece.length && isWhitespaceCharCode(piece.charCodeAt(colonProbe))) colonProbe++;
            if (piece.charCodeAt(colonProbe) === 58) {
                typeTag = piece.slice(tagStart, tagEnd);
                cursor = colonProbe + 1;
            }
        }

        while (cursor < piece.length && isWhitespaceCharCode(piece.charCodeAt(cursor))) cursor++;
        if (!isPawnIdentifierStartCode(piece.charCodeAt(cursor))) return null;
        const nameStart = cursor;
        cursor++;
        while (cursor < piece.length && isPawnIdentifierContinueCode(piece.charCodeAt(cursor))) cursor++;
        const name = piece.slice(nameStart, cursor);
        if (FORBIDDEN.has(name)) return null;

        return {
            typeTag,
            name,
            nameOffsetInPiece: baseOffset + nameStart,
            rest: piece.slice(cursor).trimStart()
        };
    }

    function readUnexpectedEnumMemberStartIssue(source) {
        const piece = String(source || '');
        let cursor = 0;
        while (cursor < piece.length && isWhitespaceCharCode(piece.charCodeAt(cursor))) cursor++;
        if (cursor >= piece.length || piece[cursor] === '}') return null;
        if (parseEnumMemberPrefix(piece)) return null;

        let end = cursor + 1;
        while (
            end < piece.length &&
            !isWhitespaceCharCode(piece.charCodeAt(end)) &&
            !/[,;[\](){}]/.test(piece[end] || '')
        ) {
            end++;
        }
        return {
            start: cursor,
            end: Math.max(cursor + 1, end),
            token: piece.slice(cursor, Math.max(cursor + 1, end))
        };
    }

    function collectEnumMemberSyntaxIssues(rawLines, strippedLines = null, lineCtrlChars = [], targetLineNumbers = null) {
        const scanLines = strippedLines || rawLines;
        const targetLines = targetLineNumbers instanceof Set ? targetLineNumbers : null;
        const shouldIncludeLine = lineNumber => !targetLines || targetLines.has(lineNumber);
        const issues = [];

        for (let startLine = 0; startLine < scanLines.length; startLine++) {
            if (!isPotentialEnumDeclarationLine(scanLines[startLine])) continue;

            let braceDepth = 0;
            let foundOpen = false;
            let blockComment = false;
            let inStr = false;
            let strCh = '';
            let endLine = startLine;

            outer:
            for (let lineNo = startLine; lineNo < rawLines.length; lineNo++) {
                const line = String(rawLines[lineNo] || '');
                const escapeChar = lineCtrlChars[lineNo] || getActiveCtrlChar();
                endLine = lineNo;

                for (let index = 0; index < line.length; index++) {
                    const char = line[index];
                    const next = line[index + 1] || '';
                    if (blockComment) {
                        if (char === '*' && next === '/') {
                            blockComment = false;
                            index++;
                        }
                        continue;
                    }
                    if (inStr) {
                        if (char === strCh && !isEscapedQuote(line, index, escapeChar)) inStr = false;
                        continue;
                    }
                    if (char === '/' && next === '/') break;
                    if (char === '/' && next === '*') {
                        blockComment = true;
                        index++;
                        continue;
                    }
                    if (char === '"' || char === "'") {
                        inStr = true;
                        strCh = char;
                        continue;
                    }
                    if (char === '{') {
                        braceDepth++;
                        foundOpen = true;
                    } else if (char === '}') {
                        braceDepth--;
                        if (foundOpen && braceDepth === 0) break outer;
                    }
                }
            }

            if (!foundOpen || braceDepth !== 0) continue;
            const strippedBlockLines = [];
            for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
                strippedBlockLines.push(String(scanLines[lineNumber] || ''));
            }
            const strippedBlockText = strippedBlockLines.join('\n');
            const strippedOpenIdx = strippedBlockText.indexOf('{');
            const strippedCloseIdx = strippedBlockText.lastIndexOf('}');
            if (strippedOpenIdx < 0 || strippedCloseIdx <= strippedOpenIdx) {
                startLine = endLine;
                continue;
            }
            const body = maskPreprocessorDirectiveLines(strippedBlockText.slice(strippedOpenIdx + 1, strippedCloseIdx));
            const bodyBlockOffset = strippedOpenIdx + 1;

            for (const rawPart of splitTopLevelWithOffsets(body)) {
                const sourcePiece = stripLineComment(rawPart.text);
                const issue = readUnexpectedEnumMemberStartIssue(sourcePiece);
                if (!issue) continue;
                const absoluteOffset = bodyBlockOffset + rawPart.startOffset + issue.start;
                const issueLineOffset = countLineBreaks(strippedBlockText, 0, absoluteOffset);
                const lineNumber = startLine + issueLineOffset;
                if (!shouldIncludeLine(lineNumber)) continue;
                const lineStartOffset = strippedBlockText.lastIndexOf('\n', absoluteOffset - 1) + 1;
                issues.push({
                    lineNumber,
                    startIndex: absoluteOffset - lineStartOffset,
                    length: Math.max(1, issue.end - issue.start),
                    messageKey: 'validation.unexpectedToken',
                    params: { token: issue.token }
                });
            }
            startLine = endLine;
        }

        return issues;
    }

    return {
        collectEnumMemberSyntaxIssues,
        parseEnumMemberPrefix,
        splitTopLevelWithOffsets
    };
}

module.exports = { createEnumSyntaxDiagnosticsCore };
