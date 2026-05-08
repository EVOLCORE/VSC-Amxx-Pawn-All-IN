const { createSemanticSyntaxCore } = require('./semantic-classifier');

// Shared syntax/text helpers used across validation, declarations, hover, and
// call analysis. These are language-mechanics helpers, not feature logic.
function createSyntaxCore(deps) {
    const {
        getActiveCtrlChar,
        isEscapedQuote,
        getCommentAnalysisForLines,
        getCommentDocsForLine
    } = deps;
    const semanticSyntaxCore = createSemanticSyntaxCore({
        isEscapedQuote
    });

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

    function splitTopLevel(str, escapeChar = getActiveCtrlChar(), keepEmpty = false) {
        if (!str?.trim()) return [];
        const parts = [];
        let d = 0, inStr = false, strCh = '', start = 0;
        for (let i = 0; i < str.length; i++) {
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
            if ('[({'.includes(c)) d++;
            else if ('])}'.includes(c)) d--;
            else if (c === ',' && d === 0) {
                const p = str.slice(start, i).trim();
                if (p || keepEmpty) parts.push(p);
                start = i + 1;
            }
        }
        const last = str.slice(start).trim();
        if (last || keepEmpty) parts.push(last);
        return parts;
    }

    function splitTopLevelWithRanges(str, baseOffset = 0, escapeChar = getActiveCtrlChar(), keepEmpty = false) {
        if (!str?.trim()) return [];
        const parts = [];
        let d = 0, inStr = false, strCh = '', start = 0;
        for (let i = 0; i < str.length; i++) {
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
            if ('[({'.includes(c)) d++;
            else if ('])}'.includes(c)) d--;
            else if (c === ',' && d === 0) {
                const raw = str.slice(start, i);
                const trimmed = raw.trim();
                if (trimmed || keepEmpty) {
                    const leadingTrim = raw.search(/\S|$/);
                    const trailingTrim = raw.length - raw.trimEnd().length;
                    parts.push({
                        text: trimmed,
                        startOffset: baseOffset + start + leadingTrim,
                        endOffset: baseOffset + i - trailingTrim
                    });
                }
                start = i + 1;
            }
        }
        const raw = str.slice(start);
        const trimmed = raw.trim();
        if (trimmed || keepEmpty) {
            const leadingTrim = raw.search(/\S|$/);
            const trailingTrim = raw.length - raw.trimEnd().length;
            parts.push({
                text: trimmed,
                startOffset: baseOffset + start + leadingTrim,
                endOffset: baseOffset + str.length - trailingTrim
            });
        }
        return parts;
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
        const DIM_RE = /^\s*(\[[^\]]*\])/;
        let dims = '', m;
        while ((m = s.match(DIM_RE))) { dims += m[1]; s = s.slice(m[0].length); }
        return { dims, rest: s.trimStart() };
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
        parseWholeCallExpression,
        looksLikePawnExpressionFragment,
        extractDocs,
        parseDims,
        parseValueAndRemainder
    };
}

module.exports = { createSyntaxCore };
