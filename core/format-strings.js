const FORMAT_SPECIFIER_VALUE_CONSUME_COUNTS = Object.freeze({
    a: 1,
    A: 1,
    b: 1,
    c: 1,
    C: 1,
    d: 1,
    D: 1,
    e: 1,
    E: 1,
    f: 1,
    F: 1,
    g: 1,
    G: 1,
    i: 1,
    l: 1,
    L: 2,
    n: 1,
    N: 1,
    o: 1,
    p: 1,
    s: 1,
    S: 1,
    u: 1,
    x: 1,
    X: 1
});

const DEFAULT_FORMAT_SPECIFIERS = new Set(Object.keys(FORMAT_SPECIFIER_VALUE_CONSUME_COUNTS));

// The C printf space flag is intentionally omitted: in Pawn source it makes
// ordinary text such as "100% sure" look like a "% s" placeholder.
const FORMAT_FLAG_CHARS = new Set(['-', '+', '#', '0']);

function isDigit(char) {
    return char >= '0' && char <= '9';
}

function readFormatWidthOrPrecision(source, cursor, contentEndOffset) {
    const text = String(source || '');
    let nextCursor = cursor;
    let consumes = 0;
    if (text[nextCursor] === '*') {
        consumes++;
        nextCursor++;
    } else {
        while (nextCursor < contentEndOffset && isDigit(text[nextCursor])) nextCursor++;
    }
    return { cursor: nextCursor, consumes };
}

function readFormatPrecisionSuffix(source, cursor, contentEndOffset) {
    const text = String(source || '');
    let nextCursor = cursor;
    let consumes = 0;
    while (nextCursor < contentEndOffset && text[nextCursor] === '.') {
        nextCursor++;
        const precisionPart = readFormatWidthOrPrecision(text, nextCursor, contentEndOffset);
        consumes += precisionPart.consumes;
        nextCursor = precisionPart.cursor;
    }
    return { cursor: nextCursor, consumes };
}

function normalizeFormatEscapePredicate(isEscapedQuote) {
    return typeof isEscapedQuote === 'function'
        ? isEscapedQuote
        : (() => false);
}

function findStringLiteralRanges(source, startOffset = 0, endOffset = String(source || '').length, options = {}) {
    const text = String(source || '');
    const isEscaped = normalizeFormatEscapePredicate(options.isEscapedQuote);
    const escapeChar = options.escapeChar || '';
    const ranges = [];
    let inString = false;
    let quote = '';
    let literalStart = -1;

    for (let index = Math.max(0, startOffset); index < Math.min(text.length, endOffset); index++) {
        const char = text[index];
        if (inString) {
            if (char === quote && !isEscaped(text, index, escapeChar)) {
                ranges.push({
                    quote,
                    startOffset: literalStart,
                    endOffset: index + 1,
                    contentStartOffset: literalStart + 1,
                    contentEndOffset: index
                });
                inString = false;
                quote = '';
                literalStart = -1;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            inString = true;
            quote = char;
            literalStart = index;
        }
    }

    return ranges;
}

function getSpecifierValueConsumeCount(specifier) {
    if (specifier === '%') return 0;
    return FORMAT_SPECIFIER_VALUE_CONSUME_COUNTS[specifier] || 0;
}

function readFormatPlaceholder(source, percentOffset, contentEndOffset, options = {}) {
    const text = String(source || '');
    if (text[percentOffset] !== '%') return null;
    let cursor = percentOffset + 1;
    if (cursor >= contentEndOffset) return null;
    if (text[cursor] === '%') {
        return {
            specifier: '%',
            startOffset: percentOffset,
            endOffset: cursor + 1,
            raw: text.slice(percentOffset, cursor + 1),
            consumes: 0,
            valueConsumes: 0,
            widthPrecisionConsumes: 0
        };
    }

    while (cursor < contentEndOffset && FORMAT_FLAG_CHARS.has(text[cursor])) cursor++;

    const widthPart = readFormatWidthOrPrecision(text, cursor, contentEndOffset);
    let widthPrecisionConsumes = widthPart.consumes;
    cursor = widthPart.cursor;

    const precisionPart = readFormatPrecisionSuffix(text, cursor, contentEndOffset);
    widthPrecisionConsumes += precisionPart.consumes;
    cursor = precisionPart.cursor;

    const specifier = text[cursor] || '';
    const specifiers = options.specifiers || DEFAULT_FORMAT_SPECIFIERS;
    if (!specifier || !specifiers.has(specifier)) return null;

    const valueConsumes = getSpecifierValueConsumeCount(specifier);
    return {
        specifier,
        startOffset: percentOffset,
        endOffset: cursor + 1,
        raw: text.slice(percentOffset, cursor + 1),
        consumes: widthPrecisionConsumes + valueConsumes,
        valueConsumes,
        widthPrecisionConsumes
    };
}

function collectFormatPlaceholdersInStringRange(source, contentStartOffset, contentEndOffset, options = {}) {
    const text = String(source || '');
    const placeholders = [];
    for (let index = contentStartOffset; index < contentEndOffset; index++) {
        if (text[index] !== '%') continue;
        const placeholder = readFormatPlaceholder(text, index, contentEndOffset, options);
        if (!placeholder) continue;
        if (placeholder.consumes > 0) placeholders.push(placeholder);
        index = Math.max(index, placeholder.endOffset - 1);
    }
    return placeholders;
}

function isCallParenAtOffset(source, parenOffset) {
    const text = String(source || '');
    for (let index = parenOffset - 1; index >= 0; index--) {
        const char = text[index];
        if (/\s/.test(char)) continue;
        return /[A-Za-z0-9_@\]\)]/.test(char);
    }
    return false;
}

function findMatchingParenInRange(source, openOffset, endOffset, options = {}) {
    const text = String(source || '');
    const isEscaped = normalizeFormatEscapePredicate(options.isEscapedQuote);
    const escapeChar = options.escapeChar || '';
    let depth = 0;
    let inString = false;
    let quote = '';
    let inLineComment = false;
    let inBlockComment = false;
    for (let index = openOffset; index < Math.min(text.length, endOffset); index++) {
        const char = text[index];
        const next = index + 1 < text.length ? text[index + 1] : '';
        if (inLineComment) {
            if (char === '\n' || char === '\r') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                index++;
            }
            continue;
        }
        if (inString) {
            if (char === quote && !isEscaped(text, index, escapeChar)) {
                inString = false;
                quote = '';
            }
            continue;
        }
        if (char === '/' && next === '/') {
            inLineComment = true;
            index++;
            continue;
        }
        if (char === '/' && next === '*') {
            inBlockComment = true;
            index++;
            continue;
        }
        if (char === '"' || char === "'") {
            inString = true;
            quote = char;
            continue;
        }
        if (char === '(') depth++;
        else if (char === ')') {
            depth--;
            if (depth === 0) return index;
            if (depth < 0) return -1;
        }
    }
    return -1;
}

function trimRange(source, startOffset, endOffset) {
    const text = String(source || '');
    let start = Math.max(0, startOffset | 0);
    let end = Math.max(start, Math.min(text.length, endOffset | 0));
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    return { startOffset: start, endOffset: end };
}

function stripTransparentOuterParensRange(source, startOffset, endOffset, options = {}) {
    const text = String(source || '');
    let range = trimRange(text, startOffset, endOffset);
    while (range.endOffset - range.startOffset >= 2 &&
        text[range.startOffset] === '(' &&
        !isCallParenAtOffset(text, range.startOffset)) {
        const closeOffset = findMatchingParenInRange(text, range.startOffset, range.endOffset, options);
        if (closeOffset !== range.endOffset - 1) break;
        range = trimRange(text, range.startOffset + 1, range.endOffset - 1);
    }
    return range;
}

function splitTopLevelTernaryValueRanges(source, startOffset, endOffset, options = {}) {
    const text = String(source || '');
    const range = stripTransparentOuterParensRange(text, startOffset, endOffset, options);
    const isEscaped = normalizeFormatEscapePredicate(options.isEscapedQuote);
    const escapeChar = options.escapeChar || '';
    let depth = 0;
    let ternaryDepth = 0;
    let questionOffset = -1;
    let inString = false;
    let quote = '';
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = range.startOffset; index < range.endOffset; index++) {
        const char = text[index];
        const next = index + 1 < text.length ? text[index + 1] : '';
        if (inLineComment) {
            if (char === '\n' || char === '\r') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                index++;
            }
            continue;
        }
        if (inString) {
            if (char === quote && !isEscaped(text, index, escapeChar)) {
                inString = false;
                quote = '';
            }
            continue;
        }
        if (char === '/' && next === '/') {
            inLineComment = true;
            index++;
            continue;
        }
        if (char === '/' && next === '*') {
            inBlockComment = true;
            index++;
            continue;
        }
        if (char === '"' || char === "'") {
            inString = true;
            quote = char;
            continue;
        }
        if ('[({'.includes(char)) {
            depth++;
            continue;
        }
        if ('])}'.includes(char)) {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0) continue;
        if (char === '?') {
            if (questionOffset < 0) questionOffset = index;
            else ternaryDepth++;
            continue;
        }
        if (char === ':' && questionOffset >= 0) {
            if (ternaryDepth > 0) {
                ternaryDepth--;
                continue;
            }
            return [
                ...splitTopLevelTernaryValueRanges(text, questionOffset + 1, index, options),
                ...splitTopLevelTernaryValueRanges(text, index + 1, range.endOffset, options)
            ];
        }
    }

    return [range];
}

function findSurfaceStringLiteralRanges(source, startOffset, endOffset, options = {}) {
    const text = String(source || '');
    const isEscaped = normalizeFormatEscapePredicate(options.isEscapedQuote);
    const escapeChar = options.escapeChar || '';
    const ranges = [];
    const stack = [];
    let inString = false;
    let quote = '';
    let literalStart = -1;
    let inLineComment = false;
    let inBlockComment = false;

    const insideCall = () => stack.some(frame => frame.call);
    for (let index = Math.max(0, startOffset); index < Math.min(text.length, endOffset); index++) {
        const char = text[index];
        const next = index + 1 < text.length ? text[index + 1] : '';
        if (inLineComment) {
            if (char === '\n' || char === '\r') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                index++;
            }
            continue;
        }
        if (inString) {
            if (char === quote && !isEscaped(text, index, escapeChar)) {
                if (!insideCall()) {
                    ranges.push({
                        quote,
                        startOffset: literalStart,
                        endOffset: index + 1,
                        contentStartOffset: literalStart + 1,
                        contentEndOffset: index
                    });
                }
                inString = false;
                quote = '';
                literalStart = -1;
            }
            continue;
        }
        if (char === '/' && next === '/') {
            inLineComment = true;
            index++;
            continue;
        }
        if (char === '/' && next === '*') {
            inBlockComment = true;
            index++;
            continue;
        }
        if (char === '"' || char === "'") {
            inString = true;
            quote = char;
            literalStart = index;
            continue;
        }
        if (char === '(') {
            stack.push({ close: ')', call: isCallParenAtOffset(text, index) });
        } else if (char === '[') {
            stack.push({ close: ']', call: false });
        } else if (char === '{') {
            stack.push({ close: '}', call: false });
        } else if (char === ')' || char === ']' || char === '}') {
            if (stack.length && stack[stack.length - 1].close === char) stack.pop();
        }
    }
    return ranges;
}

function collectFormatPlaceholderSequencesInArgument(source, argPiece, options = {}) {
    const text = String(source || '');
    const startOffset = Number.isInteger(argPiece?.startOffset) ? argPiece.startOffset : 0;
    const endOffset = Number.isInteger(argPiece?.endOffset) ? argPiece.endOffset : startOffset;
    const branchRanges = splitTopLevelTernaryValueRanges(text, startOffset, endOffset, options);
    const sequences = [];
    for (const branchRange of branchRanges) {
        const literalRanges = findSurfaceStringLiteralRanges(
            text,
            branchRange.startOffset,
            branchRange.endOffset,
            options
        );
        const placeholders = [];
        for (const literalRange of literalRanges) {
            placeholders.push(
                ...collectFormatPlaceholdersInStringRange(
                    text,
                    literalRange.contentStartOffset,
                    literalRange.contentEndOffset,
                    options
                ).map(placeholder => ({
                    ...placeholder,
                    literalRange
                }))
            );
        }
        if (placeholders.length) sequences.push(placeholders);
    }
    return sequences;
}

function collectFormatPlaceholdersInArgument(source, argPiece, options = {}) {
    return collectFormatPlaceholderSequencesInArgument(source, argPiece, options).flat();
}

function getCallArgumentPieces(source, callCtx, options = {}) {
    const text = String(source || '');
    const openOffset = Number.isInteger(callCtx?.openOffset) ? callCtx.openOffset : -1;
    let closeOffset = Number.isInteger(callCtx?.closeOffset) ? callCtx.closeOffset : -1;
    if (openOffset < 0) return [];
    if (closeOffset < 0 && typeof options.findMatchingParenOffset === 'function') {
        closeOffset = options.findMatchingParenOffset(text, openOffset, text.length, options.ctrlCharResolver || null, options);
    }
    if (closeOffset <= openOffset) return [];
    if (typeof options.splitTopLevelWithRanges !== 'function') return [];
    return options.splitTopLevelWithRanges(
        text.slice(openOffset + 1, closeOffset),
        openOffset + 1,
        options.escapeChar || '',
        true
    );
}

function collectFormatArgumentLinksForArgumentPieces(source, args, options = {}) {
    const text = String(source || '');
    const argPieces = Array.isArray(args) ? args : [];
    if (!argPieces.length) return [];
    const maxFormatArgIndexExclusive = Number.isInteger(options.maxFormatArgIndexExclusive)
        ? Math.max(0, options.maxFormatArgIndexExclusive)
        : Infinity;

    const links = [];
    for (let argIndex = 0; argIndex < argPieces.length; argIndex++) {
        if (argIndex >= maxFormatArgIndexExclusive) break;
        const placeholderSequences = collectFormatPlaceholderSequencesInArgument(text, argPieces[argIndex], options);
        if (!placeholderSequences.length) continue;

        for (const placeholders of placeholderSequences) {
            let nextArgIndex = argIndex + 1;
            for (const placeholder of placeholders) {
                const consumedArgs = [];
                const consumeCount = Math.max(0, placeholder.consumes | 0);
                for (let consumeIndex = 0; consumeIndex < consumeCount; consumeIndex++) {
                    if (argPieces[nextArgIndex]) {
                        consumedArgs.push({
                            ...argPieces[nextArgIndex],
                            argIndex: nextArgIndex
                        });
                    }
                    nextArgIndex++;
                }
                links.push({
                    callName: options.callName || '',
                    formatArgIndex: argIndex,
                    placeholder,
                    args: consumedArgs
                });
            }
        }
    }
    return links;
}

function collectFormatArgumentLinksForCall(source, callCtx, options = {}) {
    const text = String(source || '');
    const args = getCallArgumentPieces(text, callCtx, options);
    return collectFormatArgumentLinksForArgumentPieces(text, args, {
        ...options,
        callName: callCtx?.funcName || ''
    });
}

function isOffsetDirectlyInsideRange(offset, startOffset, endOffset) {
    if (!Number.isInteger(offset) ||
        !Number.isInteger(startOffset) ||
        !Number.isInteger(endOffset)) {
        return false;
    }
    return offset >= startOffset && offset < endOffset;
}

function isOffsetPreviousCharacterInsideRange(offset, startOffset, endOffset) {
    if (!Number.isInteger(offset) ||
        !Number.isInteger(startOffset) ||
        !Number.isInteger(endOffset)) {
        return false;
    }

    // VS Code caret positions can sit just after the glyph the user sees under
    // the cursor. Treat the previous character as active too, so `%`, `%d` and
    // longer placeholders behave the same for hover and document highlights.
    const previousOffset = offset - 1;
    return previousOffset >= startOffset && previousOffset < endOffset;
}

function findFormatPlaceholderLinkAtOffset(source, callCtx, offset, options = {}) {
    const links = collectFormatArgumentLinksForCall(source, callCtx, options);
    const directLink = links.find(link =>
        isOffsetDirectlyInsideRange(offset, link.placeholder.startOffset, link.placeholder.endOffset)
    );
    if (directLink) return directLink;

    return links.find(link =>
        isOffsetPreviousCharacterInsideRange(offset, link.placeholder.startOffset, link.placeholder.endOffset)
    ) || null;
}

module.exports = {
    collectFormatArgumentLinksForArgumentPieces,
    collectFormatArgumentLinksForCall,
    collectFormatPlaceholdersInArgument,
    collectFormatPlaceholdersInStringRange,
    findFormatPlaceholderLinkAtOffset,
    findStringLiteralRanges,
    FORMAT_SPECIFIER_VALUE_CONSUME_COUNTS,
    getCallArgumentPieces,
    readFormatPlaceholder
};
