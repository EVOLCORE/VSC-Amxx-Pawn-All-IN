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
        const text = typeof source === 'string' ? source : String(source || '');
        if (!text) return [];
        const parts = [];
        const firstComma = text.indexOf(',');
        if (firstComma < 0) {
            let trimStart = 0;
            let trimStartLineOffset = 0;
            while (trimStart < text.length && isWhitespaceCharCode(text.charCodeAt(trimStart))) {
                if (text.charCodeAt(trimStart) === 10) trimStartLineOffset++;
                trimStart++;
            }
            let trimEnd = text.length;
            while (trimEnd > trimStart && isWhitespaceCharCode(text.charCodeAt(trimEnd - 1))) {
                trimEnd--;
            }
            return trimStart < trimEnd
                ? [{
                    text: text.slice(trimStart, trimEnd),
                    startOffset: trimStart,
                    startLineOffset: trimStartLineOffset
                }]
                : [];
        }

        let startOffset = 0;
        let startLineOffset = 0;
        let lineOffset = 0;
        const pushPart = endOffset => {
            let trimStart = startOffset;
            let trimStartLineOffset = startLineOffset;
            while (trimStart < endOffset && isWhitespaceCharCode(text.charCodeAt(trimStart))) {
                if (text.charCodeAt(trimStart) === 10) trimStartLineOffset++;
                trimStart++;
            }
            let trimEnd = endOffset;
            while (trimEnd > trimStart && isWhitespaceCharCode(text.charCodeAt(trimEnd - 1))) {
                trimEnd--;
            }
            if (trimStart < trimEnd) {
                parts.push({
                    text: text.slice(trimStart, trimEnd),
                    startOffset: trimStart,
                    startLineOffset: trimStartLineOffset
                });
            }
            startOffset = endOffset + 1;
            startLineOffset = lineOffset;
        };
        const escapeChar = getActiveCtrlChar();
        let depth = 0;
        let inStr = false;
        let strCh = 0;
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            if (code === 10) {
                lineOffset++;
            }
            if (inStr) {
                if (code === strCh && !isEscapedQuote(text, index, escapeChar)) {
                    inStr = false;
                }
                continue;
            }
            if (code === 34 || code === 39) {
                inStr = true;
                strCh = code;
                continue;
            }
            if (code === 91 || code === 40 || code === 123) depth++;
            else if (code === 93 || code === 41 || code === 125) depth--;
            else if (code === 44 && depth === 0) {
                pushPart(index);
            }
        }
        pushPart(text.length);
        return parts;
    }

    function countLineBreaksInSpan(source, start, end) {
        let count = 0;
        for (let index = start; index < end; index++) {
            if (source.charCodeAt(index) === 10) count++;
        }
        return count;
    }

    function skipWhitespaceWithLineOffset(source, cursor, lineOffset) {
        let nextCursor = cursor;
        let nextLineOffset = lineOffset;
        while (nextCursor < source.length && isWhitespaceCharCode(source.charCodeAt(nextCursor))) {
            if (source.charCodeAt(nextCursor) === 10) nextLineOffset++;
            nextCursor++;
        }
        return { cursor: nextCursor, lineOffset: nextLineOffset };
    }

    function parseEnumMemberPrefixFrom(source, startOffset = 0, baseOffset = 0, baseLineOffset = 0) {
        const piece = String(source || '');
        let cursor = Math.max(0, startOffset | 0);
        let lineOffset = Math.max(0, baseLineOffset | 0);
        ({ cursor, lineOffset } = skipWhitespaceWithLineOffset(piece, cursor, lineOffset));
        if (cursor >= piece.length) return null;

        let typeTag = '';
        const tagStart = cursor;
        const tagStartLineOffset = lineOffset;
        const firstCode = piece.charCodeAt(cursor);
        if (firstCode === 123) {
            const closeBrace = piece.indexOf('}', cursor + 1);
            if (closeBrace > cursor) {
                let colonProbe = closeBrace + 1;
                let colonLineOffset = tagStartLineOffset + countLineBreaksInSpan(piece, tagStart, colonProbe);
                const colonWhitespace = skipWhitespaceWithLineOffset(piece, colonProbe, colonLineOffset);
                colonProbe = colonWhitespace.cursor;
                colonLineOffset = colonWhitespace.lineOffset;
                if (piece.charCodeAt(colonProbe) === 58) {
                    typeTag = piece.slice(cursor, closeBrace + 1);
                    cursor = colonProbe + 1;
                    lineOffset = colonLineOffset;
                }
            }
        } else if (isPawnIdentifierStartCode(firstCode)) {
            let tagEnd = cursor + 1;
            while (tagEnd < piece.length && isPawnIdentifierContinueCode(piece.charCodeAt(tagEnd))) tagEnd++;
            let colonProbe = tagEnd;
            let colonLineOffset = tagStartLineOffset + countLineBreaksInSpan(piece, tagStart, colonProbe);
            const colonWhitespace = skipWhitespaceWithLineOffset(piece, colonProbe, colonLineOffset);
            colonProbe = colonWhitespace.cursor;
            colonLineOffset = colonWhitespace.lineOffset;
            if (piece.charCodeAt(colonProbe) === 58) {
                typeTag = piece.slice(tagStart, tagEnd);
                cursor = colonProbe + 1;
                lineOffset = colonLineOffset;
            }
        }

        ({ cursor, lineOffset } = skipWhitespaceWithLineOffset(piece, cursor, lineOffset));
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
            nameLineOffsetInPiece: lineOffset,
            rest: piece.slice(cursor).trimStart()
        };
    }

    function parseEnumMemberPrefix(source, baseOffset = 0) {
        return parseEnumMemberPrefixFrom(source, 0, baseOffset, 0);
    }

    function isEnumMemberStartIssueBoundaryCode(code) {
        return (
            code === 40 || // (
            code === 41 || // )
            code === 44 || // ,
            code === 59 || // ;
            code === 91 || // [
            code === 93 || // ]
            code === 123 || // {
            code === 125    // }
        );
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
            !isEnumMemberStartIssueBoundaryCode(piece.charCodeAt(end))
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
        parseEnumMemberPrefixFrom,
        splitTopLevelWithOffsets
    };
}

module.exports = { createEnumSyntaxDiagnosticsCore };
