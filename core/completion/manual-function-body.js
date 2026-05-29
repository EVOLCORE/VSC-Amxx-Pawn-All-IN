const { normalizeBlockBraceStyle } = require('./block-snippets');

function normalizeManualFunctionBodyStyle(value) {
    const text = String(value || '').trim().toLowerCase();
    if (text === 'disabled') return 'disabled';
    return normalizeBlockBraceStyle(text);
}

function getLineText(document, lineNumber) {
    if (!document || !Number.isInteger(lineNumber) || lineNumber < 0 || lineNumber >= (document.lineCount || 0)) {
        return '';
    }
    return String(document.lineAt(lineNumber)?.text || '');
}

function isWhitespaceOnlyLine(text) {
    return String(text || '').trim().length === 0;
}

function isBlockedHeaderLeadWord(source) {
    const word = String(source || '').trim().match(/^@?[A-Za-z_][A-Za-z0-9_]*/)?.[0] || '';
    return /^(?:if|for|while|switch|do|else|case|default|return|sizeof|charsmax)$/i.test(word.replace(/^@/, ''));
}

function hasStateSpecOnlyTail(tail) {
    const text = String(tail || '').trim();
    return !text || /^<[^<>{};]*>$/.test(text);
}

function readHeaderCandidateBeforeEnter(document, bodyLine) {
    const pieces = [];
    let startLineText = '';
    const minLine = Math.max(0, bodyLine - 12);
    for (let line = bodyLine - 1; line >= minLine; line--) {
        const lineText = getLineText(document, line);
        const trimmed = lineText.trim();
        if (!trimmed) break;
        if (trimmed.startsWith('#') || /[;{}]\s*$/.test(trimmed)) break;
        pieces.unshift(trimmed);
        startLineText = lineText;
        const joined = pieces.join(' ');
        if (joined.includes('(') && joined.includes(')')) {
            return {
                text: joined,
                startLineText
            };
        }
    }
    return null;
}

function couldCompleteManualFunctionBodyAfterEnter(document, position) {
    if (!document || !position) return false;
    const bodyLine = Number(position.line);
    if (!Number.isInteger(bodyLine) || bodyLine <= 0 || bodyLine >= (document.lineCount || 0)) return false;
    if (!isWhitespaceOnlyLine(getLineText(document, bodyLine))) return false;

    const headerCandidate = readHeaderCandidateBeforeEnter(document, bodyLine);
    const headerLineText = headerCandidate?.startLineText || '';
    const trimmed = headerCandidate?.text || '';
    if (!trimmed || trimmed.startsWith('#') || trimmed.includes(';')) return false;
    if (/[{}]\s*$/.test(trimmed)) return false;

    const closeParen = trimmed.lastIndexOf(')');
    if (closeParen <= 0) return false;
    const openParen = trimmed.lastIndexOf('(', closeParen);
    if (openParen <= 0) return false;
    if (isBlockedHeaderLeadWord(trimmed)) return false;
    if (!hasStateSpecOnlyTail(trimmed.slice(closeParen + 1))) return false;

    const beforeParen = trimmed.slice(0, openParen).trim();
    if (/^\s+/.test(headerLineText) && !/^(?:public|stock|static|@)|:/.test(beforeParen)) {
        return false;
    }
    return /(?:^|[\s:])@?[A-Za-z_][A-Za-z0-9_]*$/.test(beforeParen);
}

function getLeadingWhitespace(text) {
    return String(text || '').match(/^\s*/)?.[0] || '';
}

function getTrimEndLength(text) {
    return String(text || '').replace(/\s+$/, '').length;
}

function findLastHeaderCloseParen(lineText) {
    return String(lineText || '').lastIndexOf(')');
}

function removeStateSpecTail(tail, functionDecl) {
    const source = String(tail || '').trimStart();
    const rawStateSpec = String(functionDecl?.stateSpec?.raw || '').trim();
    if (!rawStateSpec || !source.startsWith(rawStateSpec)) return source;
    return source.slice(rawStateSpec.length).trimStart();
}

function hasNonBodyTailAfterHeader(lineText, functionDecl) {
    const source = String(lineText || '');
    const closeParen = findLastHeaderCloseParen(source);
    if (closeParen < 0) return false;
    const tail = removeStateSpecTail(source.slice(closeParen + 1), functionDecl).trim();
    return !!tail;
}

function isFunctionBodyBoundaryLine(trimmedLine) {
    const text = String(trimmedLine || '').trim();
    if (!text) return false;
    if (text.startsWith('{')) return true;
    if (text.startsWith('#')) return false;
    return false;
}

function isExplicitDeclarationBoundaryLine(trimmedLine) {
    const text = String(trimmedLine || '').trim();
    if (!text) return false;
    if (text.startsWith('#')) return true;
    return /^(?:@?[A-Za-z_][A-Za-z0-9_]*:)?\s*(?:native|forward|public|stock|static|new|const|enum)\b/.test(text);
}

function looksLikeFunctionBoundaryAtLine(lines, lineNumber) {
    const text = String(lines?.[lineNumber] || '').trim();
    if (!text || text.includes(';') || text.startsWith('#')) return false;
    if (!/^@?[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*@?[A-Za-z_][A-Za-z0-9_]*)?\s*\(/.test(text) &&
        !/^(?:public|stock|static)\b/.test(text)) {
        return false;
    }
    if (text.includes('{')) return true;
    const nextLine = findNextMeaningfulLine(lines, lineNumber + 1);
    return nextLine >= 0 && String(lines[nextLine] || '').trim().startsWith('{');
}

function findNextMeaningfulLine(lines, startLine) {
    if (!Array.isArray(lines)) return -1;
    for (let line = Math.max(0, startLine); line < lines.length; line++) {
        if (String(lines[line] || '').trim()) return line;
    }
    return -1;
}

function findFunctionEndingAtLine(functions, headerEndLine) {
    if (!Array.isArray(functions) || !Number.isInteger(headerEndLine)) return null;
    let best = null;
    for (const fn of functions) {
        if (!fn || (fn.headerEndLine ?? fn.startLine ?? fn.lineNumber) !== headerEndLine) continue;
        if (!best || (fn.startLine ?? fn.lineNumber ?? -1) > (best.startLine ?? best.lineNumber ?? -1)) {
            best = fn;
        }
    }
    return best;
}

function isInsertableFunctionDecl(functionDecl, depths, headerEndLine) {
    if (!functionDecl) return false;
    const type = String(functionDecl.type || '').toLowerCase();
    if (type === 'native' || type === 'forward' || type === 'define') return false;
    if (Number.isInteger(functionDecl.singleStatementBodyLine)) return false;
    const headerStartLine = functionDecl.startLine ?? functionDecl.lineNumber ?? headerEndLine;
    return (depths?.[headerStartLine] ?? 0) === 0;
}

function getNextLineBodyState(ctx, bodyLine) {
    const strippedLines = Array.isArray(ctx?.strippedLines) ? ctx.strippedLines : [];
    const nextLine = findNextMeaningfulLine(strippedLines, bodyLine + 1);
    if (nextLine < 0) return 'empty';
    const trimmed = String(strippedLines[nextLine] || '').trim();
    if (isFunctionBodyBoundaryLine(trimmed)) return 'body';
    return (isExplicitDeclarationBoundaryLine(trimmed) || looksLikeFunctionBoundaryAtLine(strippedLines, nextLine))
        ? 'boundary'
        : 'single-statement-body';
}

function getManualFunctionBodyInsertionPlan(document, position, ctx, options = {}) {
    const style = normalizeManualFunctionBodyStyle(options.braceStyle);
    if (style === 'disabled') return null;
    if (!document || !position || !ctx?.parsedDecls) return null;
    if (!couldCompleteManualFunctionBodyAfterEnter(document, position)) return null;

    const bodyLine = Number(position.line);
    if (!Number.isInteger(bodyLine) || bodyLine <= 0 || bodyLine >= (document.lineCount || 0)) return null;

    const currentLineText = getLineText(document, bodyLine);
    if (!isWhitespaceOnlyLine(currentLineText)) return null;

    const headerEndLine = bodyLine - 1;
    const functionDecl = findFunctionEndingAtLine(ctx.parsedDecls.functions, headerEndLine);
    if (!isInsertableFunctionDecl(functionDecl, ctx.parsedDecls.depths, headerEndLine)) return null;

    const headerLineText = getLineText(document, headerEndLine);
    const strippedHeaderLineText = String(ctx.strippedLines?.[headerEndLine] ?? headerLineText);
    if (hasNonBodyTailAfterHeader(strippedHeaderLineText, functionDecl)) return null;
    if (hasNonBodyTailAfterHeader(headerLineText, functionDecl)) return null;

    const nextLineState = getNextLineBodyState(ctx, bodyLine);
    if (nextLineState === 'body' || nextLineState === 'single-statement-body') return null;

    const headerIndent = getLeadingWhitespace(getLineText(document, functionDecl.startLine ?? functionDecl.lineNumber ?? headerEndLine));
    const bodyIndent = `${headerIndent}\t`;
    const closeIndent = headerIndent;
    const lineLength = currentLineText.length;
    const headerTrimEnd = getTrimEndLength(headerLineText);

    const snippetText = style === 'next-line'
        ? `${headerIndent}{\n${bodyIndent}$0\n${closeIndent}}`
        : `${bodyIndent}$0\n${closeIndent}}`;

    return {
        style,
        functionDecl,
        headerEdit: style === 'same-line'
            ? {
                line: headerEndLine,
                startCharacter: headerTrimEnd,
                endCharacter: headerLineText.length,
                text: ' {'
            }
            : null,
        bodyEdit: {
            line: bodyLine,
            startCharacter: 0,
            endCharacter: lineLength,
            snippetText
        }
    };
}

module.exports = {
    couldCompleteManualFunctionBodyAfterEnter,
    getManualFunctionBodyInsertionPlan,
    normalizeManualFunctionBodyStyle
};
