const { createSemanticSyntaxCore } = require('./semantic-classifier');
const { createDimensionSyntaxCore } = require('./dimensions');

// Shared syntax/text helpers used across validation, declarations, hover, and
// call analysis. These are language-mechanics helpers, not feature logic.
function createSyntaxCore(deps) {
    const {
        getActiveCtrlChar,
        isEscapedQuote,
        isPawnIdentifierStartChar,
        isPawnIdentifierContinueChar,
        getCommentAnalysisForLines,
        getCommentDocsForLine
    } = deps;
    const semanticSyntaxCore = createSemanticSyntaxCore({
        isEscapedQuote,
        isIdentifierStartChar: isPawnIdentifierStartChar,
        isIdentifierContinueChar: isPawnIdentifierContinueChar
    });
    const dimensionSyntaxCore = createDimensionSyntaxCore({ isEscapedQuote });

    function stripLineComment(line, escapeChar = getActiveCtrlChar()) {
        const source = String(line || '');
        if (source.indexOf('//') < 0 && source.indexOf('/*') < 0) return line;
        let inStr = false, strCh = '';
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (inStr) {
                if (c === strCh && !isEscapedQuote(line, i, escapeChar)) inStr = false;
            } else if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
            } else if (c === '/' && line[i + 1] === '/') {
                return line.slice(0, i);
            }
        }
        return line;
    }

    function stripCommentsFromLines(lines, lineCtrlChars = [], lineIndex = null) {
        return getCommentAnalysisForLines(lines, lineCtrlChars, lineIndex).strippedLines;
    }

    function netParenDepth(str, escapeChar = getActiveCtrlChar()) {
        let d = 0, inStr = false, strCh = '';
        for (let i = 0; i < str.length; i++) {
            const c = str[i];
            if (inStr) {
                if (c === strCh && !isEscapedQuote(str, i, escapeChar)) inStr = false;
            } else if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
            } else if (c === '(') {
                d++;
            } else if (c === ')') {
                d--;
            }
        }
        return d;
    }

    function extractParenContent(str, escapeChar = getActiveCtrlChar()) {
        const start = str.indexOf('(');
        if (start < 0) return null;
        let d = 0, inStr = false, strCh = '';
        for (let i = start; i < str.length; i++) {
            const c = str[i];
            if (inStr) {
                if (c === strCh && !isEscapedQuote(str, i, escapeChar)) inStr = false;
                continue;
            }
            if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
                continue;
            }
            if (c === '(') d++;
            else if (c === ')') {
                d--;
                if (d === 0) return str.slice(start + 1, i);
            }
        }
        return null;
    }

    function splitTopLevelCore(str, baseOffset = 0, escapeChar = getActiveCtrlChar(), keepEmpty = false, withRanges = false) {
        const source = String(str || '');
        if (!source.trim()) return [];
        const parts = [];
        let d = 0, inStr = false, strCh = '', inLineComment = false, inBlockComment = false, start = 0;
        let current = '';
        const currentOffsets = withRanges ? [] : null;
        const appendCurrent = (char, index) => {
            current += char;
            if (withRanges) currentOffsets.push(baseOffset + index);
        };
        const pushPart = () => {
            if (withRanges) {
                const leadingTrim = current.search(/\S|$/);
                const trimmedEnd = current.trimEnd().length;
                const trimmed = current.slice(leadingTrim, trimmedEnd);
                if (trimmed || keepEmpty) {
                    const startIndex = currentOffsets[leadingTrim] ?? baseOffset + start;
                    const endIndex = trimmedEnd > leadingTrim
                        ? (currentOffsets[trimmedEnd - 1] ?? (baseOffset + start)) + 1
                        : startIndex;
                    parts.push({
                        text: trimmed,
                        startOffset: startIndex,
                        endOffset: endIndex
                    });
                }
                currentOffsets.length = 0;
            } else {
                const p = current.trim();
                if (p || keepEmpty) parts.push(p);
            }
            current = '';
        };
        for (let i = 0; i < source.length; i++) {
            const c = source[i];
            const next = i + 1 < source.length ? source[i + 1] : '';
            if (inLineComment) {
                if (c === '\n' || c === '\r') {
                    inLineComment = false;
                    appendCurrent(c, i);
                }
                continue;
            }
            if (inBlockComment) {
                if (c === '*' && next === '/') {
                    inBlockComment = false;
                    i++;
                } else if (c === '\n' || c === '\r') {
                    appendCurrent(c, i);
                }
                continue;
            }
            if (inStr) {
                if (c === strCh && !isEscapedQuote(source, i, escapeChar)) inStr = false;
                appendCurrent(c, i);
                continue;
            }
            if (c === '/' && next === '/') {
                inLineComment = true;
                appendCurrent(' ', i);
                i++;
                continue;
            }
            if (c === '/' && next === '*') {
                inBlockComment = true;
                appendCurrent(' ', i);
                i++;
                continue;
            }
            if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
                appendCurrent(c, i);
                continue;
            }
            if ('[({'.includes(c)) {
                d++;
                appendCurrent(c, i);
            }
            else if ('])}'.includes(c)) {
                d--;
                appendCurrent(c, i);
            }
            else if (c === ',' && d === 0) {
                pushPart();
                start = i + 1;
            } else {
                appendCurrent(c, i);
            }
        }
        pushPart();
        return parts;
    }

    function splitTopLevel(str, escapeChar = getActiveCtrlChar(), keepEmpty = false) {
        return splitTopLevelCore(str, 0, escapeChar, keepEmpty, false);
    }

    function splitTopLevelWithRanges(str, baseOffset = 0, escapeChar = getActiveCtrlChar(), keepEmpty = false) {
        return splitTopLevelCore(str, baseOffset, escapeChar, keepEmpty, true);
    }

    function unwrapOuterParens(str, escapeChar = getActiveCtrlChar()) {
        let source = String(str || '').trim();
        while (source.startsWith('(') && source.endsWith(')')) {
            let depth = 0;
            let inStr = false;
            let strCh = '';
            let wraps = true;

            for (let i = 0; i < source.length; i++) {
                const c = source[i];
                if (inStr) {
                    if (c === strCh && !isEscapedQuote(source, i, escapeChar)) inStr = false;
                    continue;
                }
                if (c === '"' || c === "'") {
                    inStr = true;
                    strCh = c;
                    continue;
                }
                if (c === '(') depth++;
                else if (c === ')') {
                    depth--;
                    if (depth === 0 && i < source.length - 1) {
                        wraps = false;
                        break;
                    }
                }
            }

            if (!wraps || depth !== 0) break;
            source = source.slice(1, -1).trim();
        }
        return source;
    }

    const stripRootTagCasts = (expr, escapeChar = getActiveCtrlChar()) =>
        semanticSyntaxCore.stripRootTagCasts(expr, { escapeChar });
    const parseIndexedAccessExpression = (expr, escapeChar = getActiveCtrlChar(), options = {}) => {
        const expressionOptions = typeof escapeChar === 'object' && escapeChar !== null
            ? { ...escapeChar }
            : { ...(options || {}), escapeChar };
        if (expressionOptions.escapeChar == null) {
            expressionOptions.escapeChar = getActiveCtrlChar();
        }
        return semanticSyntaxCore.parseIndexedAccessExpression(expr, expressionOptions);
    };
    const parseTopLevelTernaryExpression = (expr, escapeChar = getActiveCtrlChar()) =>
        semanticSyntaxCore.parseTopLevelTernaryExpression(expr, { escapeChar });
    const parseBraceArrayLiteralExpression = (expr, escapeChar = getActiveCtrlChar()) =>
        semanticSyntaxCore.parseBraceArrayLiteralExpression(expr, { escapeChar });
    const parseBraceArrayLiteralExpressionDetailed = (expr, escapeChar = getActiveCtrlChar()) =>
        semanticSyntaxCore.parseBraceArrayLiteralExpressionDetailed(expr, { escapeChar });
    const parseWholeCallExpression = (expr, escapeChar = getActiveCtrlChar()) =>
        semanticSyntaxCore.parseWholeCallExpression(expr, { escapeChar });
    function looksLikePawnExpressionFragment(expr, options = {}) {
        const expressionOptions = typeof options === 'string'
            ? { escapeChar: options }
            : { ...(options || {}) };
        if (expressionOptions.escapeChar == null) {
            expressionOptions.escapeChar = getActiveCtrlChar();
        }
        return semanticSyntaxCore.looksLikePawnExpressionFragment(expr, expressionOptions);
    }

    function extractDocs(lines, startLine, options = {}) {
        return getCommentDocsForLine(lines, startLine, options);
    }

    function parseDims(s) {
        return dimensionSyntaxCore.parseLeadingDims(s);
    }

    function parseValueAndRemainder(s, escapeChar = getActiveCtrlChar()) {
        let d = 0, inStr = false, strCh = '', end = s.length;
        for (let i = 1; i < s.length; i++) {
            const c = s[i];
            if (inStr) {
                if (c === strCh && !isEscapedQuote(s, i, escapeChar)) inStr = false;
                continue;
            }
            if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
                continue;
            }
            if ('[({'.includes(c)) d++;
            else if ('])}'.includes(c)) d--;
            else if (c === ',' && d === 0) { end = i; break; }
        }
        return {
            value: s.slice(1, end).trim().replace(/;$/, '').trim(),
            remainder: end < s.length ? s.slice(end + 1).trim() : ''
        };
    }

    return {
        stripLineComment,
        stripCommentsFromLines,
        netParenDepth,
        extractParenContent,
        splitTopLevel,
        splitTopLevelWithRanges,
        unwrapOuterParens,
        stripRootTagCasts,
        parseIndexedAccessExpression,
        parseTopLevelTernaryExpression,
        parseBraceArrayLiteralExpression,
        parseBraceArrayLiteralExpressionDetailed,
        parseWholeCallExpression,
        looksLikePawnExpressionFragment,
        extractDocs,
        parseDims,
        parseValueAndRemainder
    };
}

module.exports = { createSyntaxCore };
