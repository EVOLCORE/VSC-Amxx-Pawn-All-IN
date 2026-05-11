const { isPreprocessorDirectiveLine } = require('./preprocessor-lines');
const { splitPawnLines } = require('./lines');
const {
    PAWN_NON_FUNCTION_HEADER_KEYWORD_SET,
    PAWN_NON_FUNCTION_NAME_KEYWORD_SET,
    isPawnKeywordName,
    startsWithAnyPawnKeyword
} = require('./keywords');

const FUNCTION_HEADER_BLOCKING_KEYWORDS = Object.freeze([
    'if',
    'for',
    'while',
    'switch',
    'do',
    'else',
    'case',
    'default'
]);

function createFastFunctionRangeCore(deps = {}) {
    const {
        getFileSnapshot = null,
        getCtrlCharStateForContent = null
    } = deps;
    const rangesByDocument = new WeakMap();

    function scanStructuralBracesOutsideStrings(line = '', onBrace = null) {
        const source = String(line || '');
        let quote = '';
        let escaped = false;
        for (let index = 0; index < source.length; index++) {
            const char = source[index];
            if (quote) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\' || char === '^') {
                    escaped = true;
                } else if (char === quote) {
                    quote = '';
                }
                continue;
            }
            if (char === '"' || char === "'") {
                quote = char;
                continue;
            }
            if (char === '{' || char === '}') {
                onBrace?.(char, index);
            }
        }
    }

    function looksLikeFunctionHeader(headerText = '') {
        const text = String(headerText || '').replace(/\s+/g, ' ').trim();
        if (!text || isPreprocessorDirectiveLine(text) || text.includes(';')) return false;
        const openParen = text.indexOf('(');
        const closeParen = text.lastIndexOf(')');
        if (openParen <= 0 || closeParen < openParen) return false;
        const beforeParen = text.slice(0, openParen).trim();
        if (!beforeParen) return false;
        const leadingWord = beforeParen.match(/^@?[A-Za-z_][A-Za-z0-9_]*/)?.[0] || '';
        if (isPawnKeywordName(leadingWord, PAWN_NON_FUNCTION_HEADER_KEYWORD_SET, { caseInsensitive: true })) {
            return false;
        }
        const nameMatch = beforeParen.match(/(?:^|[\s:])(@?[A-Za-z_][A-Za-z0-9_]*)$/);
        if (!nameMatch) return false;
        const name = nameMatch[1].replace(/^@/, '');
        return !isPawnKeywordName(name, PAWN_NON_FUNCTION_NAME_KEYWORD_SET, { caseInsensitive: true });
    }

    function findFunctionHeaderForBrace(strippedLines, openLine, openCharIndex) {
        const pieces = [];
        const minLine = Math.max(0, openLine - 12);
        for (let line = openLine; line >= minLine; line--) {
            const source = String(strippedLines[line] || '');
            const part = line === openLine ? source.slice(0, openCharIndex) : source;
            pieces.unshift(part.trim());
            const headerText = pieces.join(' ').trim();
            if (looksLikeFunctionHeader(headerText)) {
                return { startLine: line };
            }
            if (startsWithAnyPawnKeyword(headerText, 0, FUNCTION_HEADER_BLOCKING_KEYWORDS, { caseInsensitive: true }) || /=/.test(headerText)) {
                break;
            }
            if (line < openLine) {
                const trimmed = part.trim();
                if (!trimmed) continue;
                if (isPreprocessorDirectiveLine(trimmed) || /[;{}]\s*$/.test(trimmed)) break;
            }
        }
        return null;
    }

    function getDocumentSnapshot(document) {
        const text = String(document?.getText?.() || '');
        const filePath = String(document?.fileName || '');
        if (typeof getFileSnapshot === 'function') {
            try {
                return getFileSnapshot(filePath, text);
            } catch {
                // Fall through to the standalone snapshot below.
            }
        }
        const rawLines = splitPawnLines(text);
        let strippedLines = rawLines;
        if (typeof getCtrlCharStateForContent === 'function') {
            try {
                strippedLines = getCtrlCharStateForContent(text, filePath, new Set(), rawLines)?.strippedLines || rawLines;
            } catch {
                strippedLines = rawLines;
            }
        }
        return { rawLines, strippedLines, lineIndex: null };
    }

    function getFunctionRangeState(document) {
        if (!document) return null;
        const cached = rangesByDocument.get(document);
        const version = document.version;
        const lineCount = document.lineCount || 0;
        if (cached && cached.version === version && cached.lineCount === lineCount) {
            return cached;
        }

        const snapshot = getDocumentSnapshot(document);
        if (!snapshot?.rawLines?.length || (lineCount > 1 && snapshot.rawLines.length + 1 < lineCount)) {
            return null;
        }
        const strippedLines = snapshot?.strippedLines || snapshot?.rawLines || [];
        const stack = [];
        const ranges = [];
        const depthByLine = new Int32Array(strippedLines.length);
        for (let line = 0; line < strippedLines.length; line++) {
            depthByLine[line] = stack.length;
            scanStructuralBracesOutsideStrings(strippedLines[line] || '', (char, index) => {
                if (char === '{') {
                    const header = findFunctionHeaderForBrace(strippedLines, line, index);
                    stack.push({
                        headerStartLine: header?.startLine ?? line,
                        isFunction: !!header
                    });
                } else if (char === '}') {
                    const open = stack.pop();
                    if (open?.isFunction) {
                        ranges.push({
                            startLine: open.headerStartLine,
                            endLine: line
                        });
                    }
                }
            });
        }

        ranges.sort((left, right) =>
            left.startLine - right.startLine ||
            right.endLine - left.endLine
        );
        const state = {
            version,
            lineCount,
            snapshot,
            ranges,
            depthByLine
        };
        rangesByDocument.set(document, state);
        return state;
    }

    function findEnclosingFunctionRange(document, lineNumber) {
        if (!Number.isInteger(lineNumber) || lineNumber < 0) return null;
        const state = getFunctionRangeState(document);
        if (!state) return null;
        let best = null;
        for (const range of state.ranges) {
            if (range.startLine > lineNumber) break;
            if (lineNumber <= range.endLine && (!best || range.startLine >= best.startLine)) {
                best = range;
            }
        }
        return best;
    }

    function getLocalBodyContext(document) {
        const state = getFunctionRangeState(document);
        const snapshot = state?.snapshot || null;
        if (!snapshot?.lineIndex) return null;
        return {
            lineIndex: snapshot.lineIndex,
            rawLines: snapshot.rawLines || []
        };
    }

    return {
        getFunctionRangeState,
        findEnclosingFunctionRange,
        getLocalBodyContext
    };
}

module.exports = { createFastFunctionRangeCore };
