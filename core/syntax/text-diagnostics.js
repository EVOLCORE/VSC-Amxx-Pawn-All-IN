const { isPawnIdentifierContinueChar } = require('./identifiers');
const { parsePragmaDirectiveLine } = require('./preprocessor-directives');
const { isPreprocessorDirectiveLine } = require('./preprocessor-lines');
const { findPawnLineTrimEndIndex } = require('./whitespace');

function createTextSyntaxDiagnosticsCore(deps) {
    const {
        isEscapedQuote,
        nonAsciiCharRe,
        isPawnIdentifierBoundaryChar
    } = deps;
    const PAWN_INPUT_LINE_MAX = 4095;
    const PACKED_CHAR_MAX = 0xff;

    function parsePawnLiteralChar(source, index, escapeChar = '', rawMode = false) {
        const text = String(source || '');
        if (index >= text.length) {
            return { invalid: true, value: 0, start: index, end: Math.max(index + 1, text.length) };
        }

        const start = index;
        const char = text[index];
        if (rawMode || !escapeChar || char !== escapeChar) {
            const value = text.codePointAt(index) ?? 0;
            const length = String.fromCodePoint(value).length;
            return { invalid: false, value, start, end: index + length };
        }

        index++;
        if (index >= text.length) {
            return { invalid: true, value: 0, start, end: index };
        }

        const escaped = text[index];
        if (escaped === escapeChar) return { invalid: false, value: escaped.codePointAt(0), start, end: index + 1 };
        if (escaped === 'a') return { invalid: false, value: 7, start, end: index + 1 };
        if (escaped === 'b') return { invalid: false, value: 8, start, end: index + 1 };
        if (escaped === 'e') return { invalid: false, value: 27, start, end: index + 1 };
        if (escaped === 'f') return { invalid: false, value: 12, start, end: index + 1 };
        if (escaped === 'n') return { invalid: false, value: 10, start, end: index + 1 };
        if (escaped === 'r') return { invalid: false, value: 13, start, end: index + 1 };
        if (escaped === 't') return { invalid: false, value: 9, start, end: index + 1 };
        if (escaped === 'v') return { invalid: false, value: 11, start, end: index + 1 };
        if (escaped === '\'' || escaped === '"' || escaped === '%') {
            return { invalid: false, value: escaped.codePointAt(0), start, end: index + 1 };
        }
        if (escaped === 'x') {
            index++;
            let value = 0;
            while (index < text.length && /[0-9a-fA-F]/.test(text[index])) {
                value = (value << 4) + Number.parseInt(text[index], 16);
                index++;
            }
            if (text[index] === ';') index++;
            return { invalid: false, value, start, end: index };
        }
        if (/[0-9]/.test(escaped)) {
            let value = 0;
            while (index < text.length && /[0-9]/.test(text[index])) {
                value = value * 10 + Number.parseInt(text[index], 10);
                index++;
            }
            if (text[index] === ';') index++;
            return { invalid: false, value, start, end: index };
        }

        return { invalid: true, value: 0, start, end: index + 1 };
    }

    function readStringPrefix(source, index, escapeChar = '', defaultPackedString = false) {
        const text = String(source || '');
        const char = text[index] || '';
        const next = text[index + 1] || '';
        const third = text[index + 2] || '';
        const hasEscape = !!escapeChar;

        if (char === '"') {
            return {
                start: index,
                open: index,
                raw: false,
                packed: !!defaultPackedString,
                segmentFlags: 0
            };
        }
        if (char === '!' && next === '"') {
            return {
                start: index,
                open: index + 1,
                raw: false,
                packed: !defaultPackedString,
                segmentFlags: 4
            };
        }
        if (hasEscape && char === escapeChar && next === '"') {
            return {
                start: index,
                open: index + 1,
                raw: true,
                packed: !!defaultPackedString,
                segmentFlags: 1
            };
        }
        if (hasEscape && char === '!' && next === escapeChar && third === '"') {
            return {
                start: index,
                open: index + 2,
                raw: true,
                packed: !defaultPackedString,
                segmentFlags: 5
            };
        }
        if (hasEscape && char === escapeChar && next === '!' && third === '"') {
            return {
                start: index,
                open: index + 2,
                raw: true,
                packed: !defaultPackedString,
                segmentFlags: 5
            };
        }
        return null;
    }

    function readStringConcatenation(source, index, escapeChar) {
        const text = String(source || '');
        let cursor = index;
        while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
        if (text[cursor] !== '+') return { hasPlus: false, plusIndex: -1, nextSegment: null, pendingNextLine: false };
        const plusIndex = cursor;
        cursor++;
        while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
        if (cursor >= text.length) {
            return { hasPlus: true, plusIndex, nextSegment: null, pendingNextLine: true };
        }
        return {
            hasPlus: true,
            plusIndex,
            nextSegment: readStringPrefix(text, cursor, escapeChar, false),
            pendingNextLine: false
        };
    }

    function getTrailingStringContinuationStart(source = '', escapeChar = '') {
        const text = String(source || '');
        const end = findPawnLineTrimEndIndex(text, 0, { allowCarriageReturn: true });
        if (end <= 0) return -1;
        const char = text[end - 1];
        return char === '\\' || (!!escapeChar && char === escapeChar) ? end - 1 : -1;
    }

    function findClosingStringQuote(source, segment, escapeChar = '') {
        const text = String(source || '');
        if (!segment) return -1;
        let cursor = segment.open + 1;
        while (cursor < text.length) {
            if (text[cursor] === '"' && (segment.raw || !isEscapedQuote(text, cursor, escapeChar))) {
                return cursor;
            }
            const parsed = parsePawnLiteralChar(text, cursor, escapeChar, segment.raw);
            cursor = Math.max(parsed.end, cursor + 1);
        }
        return -1;
    }

    function getLineEndStringContinuation(source = '', escapeChar = '', defaultPackedString = false) {
        const text = String(source || '');
        if (text.indexOf('"') < 0) return null;
        let lastContinuation = null;
        let inChar = false;

        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            const next = text[index + 1] || '';
            if (char === '/' && next === '/') break;
            if (inChar) {
                if (char === '\'' && !isEscapedQuote(text, index, escapeChar)) inChar = false;
                continue;
            }
            if (char === '\'') {
                inChar = true;
                continue;
            }

            const segment = readStringPrefix(text, index, escapeChar, defaultPackedString);
            if (!segment) continue;

            const closeIndex = findClosingStringQuote(text, segment, escapeChar);
            if (closeIndex < 0) break;
            const concatenation = readStringConcatenation(text, closeIndex + 1, escapeChar);
            if (concatenation.hasPlus && concatenation.pendingNextLine) {
                lastContinuation = {
                    mode: 'plusAtEnd',
                    lineNumber: -1,
                    segmentFlags: segment.segmentFlags,
                    plusStart: concatenation.plusIndex
                };
            } else if (!concatenation.hasPlus && !text.slice(closeIndex + 1).trim()) {
                lastContinuation = {
                    mode: 'stringAtEnd',
                    lineNumber: -1,
                    segmentFlags: segment.segmentFlags,
                    plusStart: -1
                };
            } else {
                lastContinuation = null;
            }
            index = closeIndex;
        }

        return lastContinuation;
    }

    function firstNonWhitespaceIndex(source = '') {
        const text = String(source || '');
        for (let index = 0; index < text.length; index++) {
            if (!/\s/.test(text[index])) return index;
        }
        return -1;
    }

    function isPreprocessorLine(source = '') {
        return isPreprocessorDirectiveLine(source);
    }

    function isTargetedMultilineIssue(issue, targetLineNumbers) {
        if (!(targetLineNumbers instanceof Set)) return true;
        return targetLineNumbers.has(issue.lineNumber) ||
            targetLineNumbers.has(issue.sourceLineNumber);
    }

    function collectPawnMultilineStringLiteralIssues(lines = [], options = {}) {
        const sourceLines = Array.isArray(lines) ? lines : [];
        const lineCtrlChars = options.lineCtrlChars || [];
        const packedStringDefaultLineFlags = options.packedStringDefaultLineFlags || [];
        const targetLineNumbers = options.targetLineNumbers instanceof Set
            ? options.targetLineNumbers
            : null;
        const issues = [];

        const pushIssue = issue => {
            if (!isTargetedMultilineIssue(issue, targetLineNumbers)) return;
            issues.push(issue);
        };
        const getEscapeChar = lineNumber => lineCtrlChars[lineNumber] || '';
        const getDefaultPacked = lineNumber => !!packedStringDefaultLineFlags[lineNumber];
        const findNextSegment = (startLine, pending) => {
            let mode = pending.mode;
            for (let lineNumber = startLine; lineNumber < sourceLines.length; lineNumber++) {
                const line = String(sourceLines[lineNumber] || '');
                let cursor = firstNonWhitespaceIndex(line);
                if (cursor < 0) continue;

                if (mode === 'stringAtEnd') {
                    if (line[cursor] !== '+') return null;
                    cursor++;
                    while (cursor < line.length && /\s/.test(line[cursor])) cursor++;
                    if (cursor >= line.length) {
                        mode = 'plusAtEnd';
                        continue;
                    }
                }

                const escapeChar = getEscapeChar(lineNumber);
                const segment = readStringPrefix(line, cursor, escapeChar, getDefaultPacked(lineNumber));
                if (!segment) {
                    return {
                        kind: 'invalidString',
                        messageKey: 'validation.invalidString',
                        sourceLineNumber: pending.lineNumber,
                        lineNumber,
                        start: cursor,
                        end: Math.max(cursor + 1, line.length)
                    };
                }

                return {
                    kind: 'segment',
                    sourceLineNumber: pending.lineNumber,
                    lineNumber,
                    start: segment.start,
                    end: segment.open + 1,
                    segmentFlags: segment.segmentFlags
                };
            }

            return {
                kind: 'invalidString',
                messageKey: 'validation.invalidString',
                sourceLineNumber: pending.lineNumber,
                lineNumber: pending.lineNumber,
                start: pending.plusStart >= 0 ? pending.plusStart : Math.max(0, String(sourceLines[pending.lineNumber] || '').length - 1),
                end: String(sourceLines[pending.lineNumber] || '').length
            };
        };

        for (let lineNumber = 0; lineNumber < sourceLines.length; lineNumber++) {
            const line = String(sourceLines[lineNumber] || '');
            if (isPreprocessorLine(line)) continue;
            const pending = getLineEndStringContinuation(
                line,
                getEscapeChar(lineNumber),
                getDefaultPacked(lineNumber)
            );
            if (!pending) continue;
            pending.lineNumber = lineNumber;
            const next = findNextSegment(lineNumber + 1, pending);
            if (!next) continue;
            if (next.kind === 'invalidString') {
                pushIssue(next);
                continue;
            }
            if (next.segmentFlags !== pending.segmentFlags) {
                pushIssue({
                    kind: 'mixedPackedRawStringConcatenation',
                    messageKey: 'validation.mixedPackedRawStringConcatenation',
                    sourceLineNumber: pending.lineNumber,
                    lineNumber: next.lineNumber,
                    start: next.start,
                    end: next.end
                });
            }
        }

        return issues;
    }

    function collectPawnLiteralIssues(source = '', escapeChar = '', options = null) {
        const text = String(source || '');
        if (!text || (text.indexOf('"') < 0 && text.indexOf('\'') < 0)) return [];

        const issues = [];
        const defaultPackedString = !!options?.defaultPackedString;
        let inString = false;
        let lineComment = false;
        let stringChar = '';
        let previousConcatenatedStringFlags = null;
        const initialQuote = options?.initialQuote === '\'' || options?.initialQuote === '"'
            ? options.initialQuote
            : '';
        if (initialQuote) {
            inString = true;
            stringChar = initialQuote;
        }
        const trailingContinuationStart = getTrailingStringContinuationStart(text, escapeChar);

        const pushIssue = (kind, messageKey, start, end) => {
            issues.push({
                kind,
                messageKey,
                start: Math.max(0, start),
                end: Math.max(start + 1, end)
            });
        };

        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            const next = text[index + 1] || '';
            if (lineComment) break;
            if (inString) {
                if (char === stringChar && !isEscapedQuote(text, index, escapeChar)) {
                    inString = false;
                    previousConcatenatedStringFlags = null;
                    continue;
                }
                if (index === trailingContinuationStart) {
                    index = text.length;
                    break;
                }
                const parsed = parsePawnLiteralChar(text, index, escapeChar, false);
                if (parsed.invalid) {
                    pushIssue('invalidCharacterConstant', 'validation.invalidCharacterConstant', parsed.start, parsed.end);
                    index = Math.max(parsed.end, index + 1) - 1;
                    continue;
                }
                if (defaultPackedString && parsed.value > PACKED_CHAR_MAX) {
                    pushIssue(
                        'characterConstantExceedsRange',
                        'validation.characterConstantExceedsRange',
                        parsed.start,
                        parsed.end
                    );
                }
                index = Math.max(parsed.end, index + 1) - 1;
                continue;
            }
            if (char === '/' && next === '/') {
                lineComment = true;
                continue;
            }
            if (char === '\'') {
                const parsed = parsePawnLiteralChar(text, index + 1, escapeChar, false);
                if (parsed.invalid || parsed.value > PACKED_CHAR_MAX || text[parsed.end] !== '\'') {
                    let end = parsed.end;
                    while (end < text.length && text[end] !== '\'' && text[end] !== '\n' && text[end] !== '\r') end++;
                    if (text[end] === '\'') end++;
                    pushIssue('invalidCharacterConstant', 'validation.invalidCharacterConstant', index, end);
                    index = Math.max(index, end - 1);
                    previousConcatenatedStringFlags = null;
                    continue;
                }
                index = parsed.end;
                previousConcatenatedStringFlags = null;
                continue;
            }

            const segment = readStringPrefix(text, index, escapeChar, defaultPackedString);
            if (!segment) {
                if (!/\s/.test(char) && char !== '+') previousConcatenatedStringFlags = null;
                continue;
            }

            if (
                previousConcatenatedStringFlags != null &&
                previousConcatenatedStringFlags !== segment.segmentFlags
            ) {
                pushIssue(
                    'mixedPackedRawStringConcatenation',
                    'validation.mixedPackedRawStringConcatenation',
                    segment.start,
                    segment.open + 1
                );
            }

            let cursor = segment.open + 1;
            let closed = false;
            let continuedToNextLine = false;
            while (cursor < text.length) {
                if (text[cursor] === '"' && (segment.raw || !isEscapedQuote(text, cursor, escapeChar))) {
                    closed = true;
                    break;
                }
                if (!segment.raw && cursor === trailingContinuationStart) {
                    continuedToNextLine = true;
                    cursor = text.length;
                    break;
                }
                const parsed = parsePawnLiteralChar(text, cursor, escapeChar, segment.raw);
                if (parsed.invalid) {
                    pushIssue('invalidCharacterConstant', 'validation.invalidCharacterConstant', parsed.start, parsed.end);
                    cursor = Math.max(parsed.end, cursor + 1);
                    continue;
                }
                if (segment.packed && parsed.value > PACKED_CHAR_MAX) {
                    pushIssue(
                        'characterConstantExceedsRange',
                        'validation.characterConstantExceedsRange',
                        parsed.start,
                        parsed.end
                    );
                }
                cursor = Math.max(parsed.end, cursor + 1);
            }

            if (!closed) {
                if (continuedToNextLine) {
                    index = text.length;
                    break;
                }
                pushIssue('invalidString', 'validation.invalidString', segment.start, text.length);
                index = text.length;
                break;
            }

            const concatenation = readStringConcatenation(text, cursor + 1, escapeChar);
            if (concatenation.hasPlus && !concatenation.nextSegment && !concatenation.pendingNextLine) {
                pushIssue('invalidString', 'validation.invalidString', concatenation.plusIndex, text.length);
                previousConcatenatedStringFlags = null;
            } else {
                previousConcatenatedStringFlags = concatenation.nextSegment ? segment.segmentFlags : null;
            }
            index = cursor;
        }

        return issues;
    }

    function parsePragmaPackValue(line) {
        const pragma = parsePragmaDirectiveLine(line);
        if (pragma?.name !== 'pack') return null;
        const value = String(pragma.value || '').trim().toLowerCase();
        if (!value) return null;
        if (value === 'true' || value === 'on') return true;
        if (value === 'false' || value === 'off') return false;
        const numeric = value.match(/^[+-]?\d+/)?.[0];
        if (numeric != null) return Number.parseInt(numeric, 10) !== 0;
        return null;
    }

    function collectPackedStringDefaultLineFlags(lines = []) {
        const sourceLines = Array.isArray(lines) ? lines : [];
        const flags = new Uint8Array(sourceLines.length);
        let packed = false;
        for (let lineNumber = 0; lineNumber < sourceLines.length; lineNumber++) {
            flags[lineNumber] = packed ? 1 : 0;
            const nextPacked = parsePragmaPackValue(sourceLines[lineNumber]);
            if (nextPacked != null) packed = nextPacked;
        }
        return flags;
    }

    function collectInvalidPawnCodeCharacterRuns(source = '', escapeChar = '', options = null) {
        const text = String(source || '');
        const invalidAsciiCharRe = /[$`]/;
        if (!nonAsciiCharRe.test(text) && !invalidAsciiCharRe.test(text)) return [];

        const runs = [];
        const initialQuote = options?.initialQuote || '';
        let inString = initialQuote === '"';
        let inChar = initialQuote === '\'';
        const isInvalidAsciiPawnCodeChar = char =>
            char === '$' || char === '`';
        const isAsciiPawnIdentifierChar = isPawnIdentifierContinueChar;
        const isInvalidPawnCodeChar = char =>
            !!char && (char.charCodeAt(0) > 0x7f || isInvalidAsciiPawnCodeChar(char));
        const isInvalidCodeTokenChar = char =>
            isInvalidPawnCodeChar(char) || isAsciiPawnIdentifierChar(char);
        const expandInvalidCodeTokenStart = start => {
            while (start > 0 && isInvalidCodeTokenChar(text[start - 1])) start--;
            return start;
        };
        const expandInvalidCodeTokenEnd = end => {
            while (end < text.length && isInvalidCodeTokenChar(text[end])) end++;
            return end;
        };
        const pushRun = (start, end) => {
            runs.push({
                start,
                end,
                text: text.slice(start, end)
            });
        };
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inString) {
                if (char === '"' && !isEscapedQuote(text, index, escapeChar)) {
                    inString = false;
                }
                continue;
            }
            if (inChar) {
                if (char === '\'' && !isEscapedQuote(text, index, escapeChar)) {
                    inChar = false;
                }
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === '\'') {
                inChar = true;
                continue;
            }
            if (char.charCodeAt(0) <= 0x7f) {
                if (!isInvalidAsciiPawnCodeChar(char)) continue;
                const start = expandInvalidCodeTokenStart(index);
                const end = expandInvalidCodeTokenEnd(index + 1);
                pushRun(start, end);
                index = end - 1;
                continue;
            }

            const start = expandInvalidCodeTokenStart(index);
            const end = expandInvalidCodeTokenEnd(index + 1);
            pushRun(start, end);
            index = end - 1;
        }
        return runs;
    }

    function maskStringLiteralContent(source = '', escapeChar = '') {
        const text = String(source || '');
        if (!text) return '';
        if (text.indexOf('"') < 0 && text.indexOf('\'') < 0) return text;
        let result = '';
        let inStr = false;
        let strCh = '';
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh && !isEscapedQuote(text, index, escapeChar)) {
                    inStr = false;
                    result += char;
                } else {
                    result += ' ';
                }
                continue;
            }
            if (char === '"' || char === '\'') {
                inStr = true;
                strCh = char;
                result += char;
                continue;
            }
            result += char;
        }
        return result;
    }

    function findIdentifierRangesInLine(lineText, name) {
        const source = String(lineText || '');
        const target = String(name || '');
        if (!source || !target) return [];

        const ranges = [];
        let searchFrom = 0;
        while (searchFrom < source.length) {
            const foundIndex = source.indexOf(target, searchFrom);
            if (foundIndex < 0) break;
            const before = source[foundIndex - 1] || '';
            const after = source[foundIndex + target.length] || '';
            if (isPawnIdentifierBoundaryChar(before) && isPawnIdentifierBoundaryChar(after)) {
                ranges.push({
                    start: foundIndex,
                    end: foundIndex + target.length
                });
            }
            searchFrom = foundIndex + target.length;
        }
        return ranges;
    }

    function hasLineBreakInsideStringLiteral(source, escapeChar = '') {
        const text = String(source || '');
        if (!text || (!text.includes('\n') && !text.includes('\r'))) return false;

        let quote = '';
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (quote) {
                if (ch === '\n' || ch === '\r') return true;
                if (ch === quote && !isEscapedQuote(text, i, escapeChar)) {
                    quote = '';
                }
                continue;
            }

            if (ch === '"' || ch === "'") {
                quote = ch;
            }
        }

        return false;
    }

    function getInputLineTooLongIssue(source = '') {
        const text = String(source || '');
        if (text.length <= PAWN_INPUT_LINE_MAX) return null;
        return {
            kind: 'inputLineTooLong',
            start: PAWN_INPUT_LINE_MAX,
            end: Math.max(PAWN_INPUT_LINE_MAX + 1, text.length),
            max: PAWN_INPUT_LINE_MAX
        };
    }

    return {
        collectPawnLiteralIssues,
        collectPawnMultilineStringLiteralIssues,
        collectPackedStringDefaultLineFlags,
        collectInvalidPawnCodeCharacterRuns,
        getInputLineTooLongIssue,
        maskStringLiteralContent,
        findIdentifierRangesInLine,
        hasLineBreakInsideStringLiteral
    };
}

module.exports = { createTextSyntaxDiagnosticsCore };
