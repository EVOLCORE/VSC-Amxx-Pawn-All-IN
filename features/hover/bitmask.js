// Bitmask-expression helpers are hover-specific: they support hover analysis
// and rendering for combined flags, but are not generic language services.
const {
    hasTrailingBackslashContinuation,
    removeTrailingBackslashContinuation
} = require('../../core/syntax/continuation');
const {
    advanceTopLevelScannerState,
    createTopLevelScannerState,
    isTopLevelScannerState
} = require('../../core/syntax/top-level');
const { pushUniqueHoverMatch } = require('./match-dedupe');

function createHoverBitmaskFeature(deps) {
    const {
        getActiveCtrlChar,
        stripLineComment,
        isEscapedQuote,
        getDocumentTextAndResolver,
        evaluatePawnNumericExpr,
        collectWordDeclMatches,
        BUILTIN_DECLS,
        getDeclMatchKey,
        FORBIDDEN
    } = deps;

    function formatBitmaskValueHex(value) {
        if (!Number.isInteger(value)) return '';
        const unsigned = value >>> 0;
        return `0x${unsigned.toString(16).toUpperCase()}`;
    }

    function formatBitmaskSetBits(value) {
        if (!Number.isInteger(value)) return '';
        const unsigned = value >>> 0;
        if (unsigned === 0) return '0';
        const parts = [];
        for (let bit = 0; bit < 32; bit++) {
            if (unsigned & (1 << bit)) {
                parts.push(`(1<<${bit})`);
            }
        }
        return parts.join('|');
    }

    function extractAssignmentBitmaskRhsInfo(expr) {
        const source = String(expr || '').trim();
        if (!source) return { expr: '', rhsStart: 0 };

        const match = source.match(/^(?:.+?)\s*(?:\|=|&=|\^=|<<=|>>=|=)\s*(.+)$/);
        if (!match) return { expr: source, rhsStart: 0 };

        const rhs = match[1].trim();
        const rhsIndex = source.lastIndexOf(match[1]);
        const rhsStart = rhsIndex >= 0
            ? rhsIndex + (match[1].length - match[1].trimStart().length)
            : 0;
        return { expr: rhs, rhsStart };
    }

    function extractAssignmentBitmaskRhs(expr) {
        return extractAssignmentBitmaskRhsInfo(expr).expr;
    }

    function isBitmaskExpressionChar(ch) {
        return /[A-Za-z0-9_@ \t()|&^~<>+\-*/%xXa-fA-F]/.test(ch);
    }

    function hasBitmaskOperator(expr) {
        const text = String(expr || '');
        for (let index = 0; index < text.length; index++) {
            const ch = text[index];
            const next = text[index + 1] || '';
            const prev = text[index - 1] || '';
            if (ch === '^') return true;
            if ((ch === '<' || ch === '>') && next === ch) return true;
            if (ch === '|' && prev !== '|' && next !== '|') return true;
            if (ch === '&' && prev !== '&' && next !== '&') return true;
        }
        return false;
    }

    function createBitmaskExpressionCandidate(start, end, rawSlice) {
        const raw = String(rawSlice || '');
        const leadingTrim = raw.length - raw.trimStart().length;
        return {
            start,
            end,
            rawSlice: raw,
            leadingTrim,
            rawExpr: raw.trim()
        };
    }

    function collectParenthesizedBitmaskCandidates(rawSlice, cursorInRaw, baseStart) {
        const text = String(rawSlice || '');
        const stack = [];
        const candidates = [];
        const pushCandidate = (openIndex, closeIndex) => {
            if (!Number.isInteger(openIndex) || openIndex < 0) return;
            const boundedClose = Number.isInteger(closeIndex) && closeIndex >= openIndex
                ? closeIndex
                : text.length;
            const contentStart = openIndex + 1;
            const contentEnd = Math.max(contentStart, boundedClose);
            if (cursorInRaw < contentStart || cursorInRaw > contentEnd) return;
            const raw = text.slice(contentStart, contentEnd);
            if (!raw.trim()) return;
            candidates.push(createBitmaskExpressionCandidate(
                baseStart + contentStart,
                baseStart + contentEnd,
                raw
            ));
        };

        for (let index = 0; index < text.length; index++) {
            const ch = text[index];
            if (ch === '(') {
                stack.push(index);
                continue;
            }
            if (ch !== ')') continue;
            const openIndex = stack.pop();
            pushCandidate(openIndex, index);
        }

        for (let index = stack.length - 1; index >= 0; index--) {
            pushCandidate(stack[index], text.length);
        }

        return candidates.sort((left, right) =>
            (right.end - right.start) - (left.end - left.start)
        );
    }

    function dedupeBitmaskExpressionCandidates(candidates) {
        const result = [];
        const seen = new Set();
        for (const candidate of candidates) {
            const key = `${candidate.start}:${candidate.end}:${candidate.rawExpr}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(candidate);
        }
        return result;
    }

    function getBitmaskExpressionSlice(lineText, cursorColumn) {
        const text = String(lineText || '');
        const column = Math.min(Math.max(0, cursorColumn), text.length);

        let start = column;
        while (start > 0 && isBitmaskExpressionChar(text[start - 1])) start--;
        let end = column;
        while (end < text.length && isBitmaskExpressionChar(text[end])) end++;

        const rawSlice = text.slice(start, end);
        const leadingTrim = rawSlice.length - rawSlice.trimStart().length;
        return {
            start,
            end,
            rawSlice,
            leadingTrim,
            rawExpr: rawSlice.trim()
        };
    }

    function getBitmaskExpressionCandidates(lineText, cursorColumn) {
        const primary = getBitmaskExpressionSlice(lineText, cursorColumn);
        const cursorInRaw = Math.max(0, cursorColumn - primary.start);
        return dedupeBitmaskExpressionCandidates([
            primary,
            ...collectParenthesizedBitmaskCandidates(
                primary.rawSlice,
                cursorInRaw,
                primary.start
            )
        ]);
    }

    function trimBitmaskContinuationLine(line, escapeChar = getActiveCtrlChar()) {
        return stripLineComment(line, escapeChar).trim();
    }

    function startsWithBitwiseOperator(line) {
        return /^(?:\||&|\^|<<|>>)/.test(String(line || '').trim());
    }

    function endsWithBitwiseContinuation(line) {
        const trimmed = removeTrailingBackslashContinuation(String(line || '').trim()).trimEnd();
        return /(?:\|=|&=|\^=|<<=|>>=|=|\||&|\^|<<|>>)$/.test(trimmed);
    }

    function hasExplicitLineContinuation(line) {
        return hasTrailingBackslashContinuation(line);
    }

    function areBitmaskLinesConnected(previousLine, nextLine) {
        const previous = String(previousLine || '').trim();
        const next = String(nextLine || '').trim();
        if (!previous || !next) return false;
        return hasExplicitLineContinuation(previous) ||
            endsWithBitwiseContinuation(previous) ||
            startsWithBitwiseOperator(next);
    }

    function buildBitmaskExpressionSource(document, lineNumber, ctrlCharResolver = null) {
        let startLine = lineNumber;
        let endLine = lineNumber;

        while (startLine > 0) {
            const prevEscapeChar = ctrlCharResolver?.ctrlCharAtLine(startLine - 1) || getActiveCtrlChar();
            const currEscapeChar = ctrlCharResolver?.ctrlCharAtLine(startLine) || getActiveCtrlChar();
            const prevLine = trimBitmaskContinuationLine(document.lineAt(startLine - 1).text, prevEscapeChar);
            const currLine = trimBitmaskContinuationLine(document.lineAt(startLine).text, currEscapeChar);
            if (!areBitmaskLinesConnected(prevLine, currLine)) break;
            startLine--;
        }

        while (endLine + 1 < document.lineCount) {
            const currEscapeChar = ctrlCharResolver?.ctrlCharAtLine(endLine) || getActiveCtrlChar();
            const nextEscapeChar = ctrlCharResolver?.ctrlCharAtLine(endLine + 1) || getActiveCtrlChar();
            const currLine = trimBitmaskContinuationLine(document.lineAt(endLine).text, currEscapeChar);
            const nextLine = trimBitmaskContinuationLine(document.lineAt(endLine + 1).text, nextEscapeChar);
            if (!areBitmaskLinesConnected(currLine, nextLine)) break;
            endLine++;
        }

        const fragments = [];
        for (let line = startLine; line <= endLine; line++) {
            const escapeChar = ctrlCharResolver?.ctrlCharAtLine(line) || getActiveCtrlChar();
            const trimmed = trimBitmaskContinuationLine(document.lineAt(line).text, escapeChar);
            if (!trimmed) continue;
            fragments.push(removeTrailingBackslashContinuation(trimmed).trim());
        }

        return {
            expr: fragments.join(' ').trim(),
            startLine,
            endLine
        };
    }

    function findBitmaskExpressionContext(document, position, allDecls) {
        const { resolver } = getDocumentTextAndResolver(document);
        const lineText = stripLineComment(
            document.lineAt(position.line).text,
            resolver?.ctrlCharAtLine(position.line) || getActiveCtrlChar()
        );
        const cursorColumn = Math.min(position.character, lineText.length);
        const candidates = getBitmaskExpressionCandidates(lineText, cursorColumn);
        const multilineSource = buildBitmaskExpressionSource(document, position.line, resolver);
        const sourceCandidates = multilineSource.startLine !== multilineSource.endLine && multilineSource.expr
            ? [createBitmaskExpressionCandidate(0, multilineSource.expr.length, multilineSource.expr), ...candidates]
            : candidates;

        for (const candidate of sourceCandidates) {
            const expr = extractAssignmentBitmaskRhs(candidate.rawExpr);
            if (!expr || !hasBitmaskOperator(expr)) continue;
            const value = evaluatePawnNumericExpr(expr, allDecls);
            if (value == null) continue;

            const words = [...new Set((expr.match(/\b[A-Za-z_@]\w*\b/g) || []).filter(name => !FORBIDDEN.has(name)))];
            return { expr, value, words };
        }

        return null;
    }

    function buildBitmaskParts(exprWords, funcArgs, locals, globals, functions, incDecls, lookup = null) {
        const parts = [];
        for (const word of exprWords) {
            const matches = collectWordDeclMatches(
                word,
                funcArgs,
                locals,
                globals,
                functions,
                incDecls,
                BUILTIN_DECLS,
                lookup
            );
            const match = matches.find(item => item.data.type === 'enum-item' || item.data.type === 'define') || matches[0];
            if (!match) continue;
            pushUniqueHoverMatch(parts, match, getDeclMatchKey);
        }
        return parts;
    }

    function splitTopLevelBitmaskTerms(expr, escapeChar = getActiveCtrlChar()) {
        return splitTopLevelBitmaskTermsWithOffsets(expr, escapeChar).map(item => item.text);
    }

    function splitTopLevelBitmaskTermsWithOffsets(expr, escapeChar = getActiveCtrlChar()) {
        const source = String(expr || '');
        const terms = [];
        let current = '';
        let currentStart = 0;
        const scannerState = createTopLevelScannerState();

        const pushTerm = endIndex => {
            const raw = current;
            const trimmed = raw.trim();
            if (!trimmed) {
                current = '';
                currentStart = endIndex;
                return;
            }

            const leadingWs = raw.match(/^\s*/)?.[0].length || 0;
            const trailingWs = raw.match(/\s*$/)?.[0].length || 0;
            terms.push({
                text: trimmed,
                start: currentStart + leadingWs,
                end: currentStart + raw.length - trailingWs
            });
            current = '';
            currentStart = endIndex;
        };

        for (let i = 0; i < source.length; i++) {
            const c = source[i];
            const next = source[i + 1] || '';

            if (advanceTopLevelScannerState(source, i, scannerState, { isEscapedQuote, escapeChar })) {
                current += c;
                continue;
            }

            const isBitwiseSeparator = isTopLevelScannerState(scannerState) &&
                (
                    (c === '|' && next !== '|' && next !== '=') ||
                    (c === '&' && next !== '&' && next !== '=') ||
                    (c === '^' && next !== '=')
                );

            if (isBitwiseSeparator) {
                pushTerm(i + 1);
                continue;
            }

            current += c;
        }

        pushTerm(source.length);
        return terms;
    }

    function extractBitmaskLiteralPartLines(expr, allDecls = []) {
        const matches = splitTopLevelBitmaskTerms(expr);
        const lines = [];
        const seen = new Set();

        for (const rawMatch of matches) {
            const raw = String(rawMatch || '').trim();
            if (!raw || seen.has(raw)) continue;
            seen.add(raw);
            if (/^[A-Za-z_@]\w*$/.test(raw)) continue;

            const value = evaluatePawnNumericExpr(raw, allDecls);
            if (value == null) continue;

            const hexValue = formatBitmaskValueHex(value);
            lines.push(hexValue ? `${raw} = ${value} [${hexValue}]` : `${raw} = ${value}`);
        }

        return lines;
    }

    return {
        formatBitmaskValueHex,
        formatBitmaskSetBits,
        hasBitmaskOperator,
        extractAssignmentBitmaskRhsInfo,
        getBitmaskExpressionSlice,
        getBitmaskExpressionCandidates,
        findBitmaskExpressionContext,
        buildBitmaskParts,
        splitTopLevelBitmaskTermsWithOffsets,
        extractBitmaskLiteralPartLines
    };
}

module.exports = { createHoverBitmaskFeature };
