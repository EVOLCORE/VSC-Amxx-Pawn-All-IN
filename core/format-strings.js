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

    let widthPrecisionConsumes = 0;
    if (text[cursor] === '*') {
        widthPrecisionConsumes++;
        cursor++;
    } else {
        while (cursor < contentEndOffset && isDigit(text[cursor])) cursor++;
    }

    if (text[cursor] === '.') {
        cursor++;
        if (text[cursor] === '*') {
            widthPrecisionConsumes++;
            cursor++;
        } else {
            while (cursor < contentEndOffset && isDigit(text[cursor])) cursor++;
        }
    }

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

function collectFormatPlaceholdersInArgument(source, argPiece, options = {}) {
    const text = String(source || '');
    const startOffset = Number.isInteger(argPiece?.startOffset) ? argPiece.startOffset : 0;
    const endOffset = Number.isInteger(argPiece?.endOffset) ? argPiece.endOffset : startOffset;
    const literalRanges = findStringLiteralRanges(text, startOffset, endOffset, options);
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
    return placeholders;
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

function collectFormatArgumentLinksForCall(source, callCtx, options = {}) {
    const text = String(source || '');
    const args = getCallArgumentPieces(text, callCtx, options);
    if (!args.length) return [];

    const links = [];
    for (let argIndex = 0; argIndex < args.length; argIndex++) {
        const placeholders = collectFormatPlaceholdersInArgument(text, args[argIndex], options);
        if (!placeholders.length) continue;

        let nextArgIndex = argIndex + 1;
        for (const placeholder of placeholders) {
            const consumedArgs = [];
            const consumeCount = Math.max(0, placeholder.consumes | 0);
            for (let consumeIndex = 0; consumeIndex < consumeCount; consumeIndex++) {
                if (args[nextArgIndex]) {
                    consumedArgs.push({
                        ...args[nextArgIndex],
                        argIndex: nextArgIndex
                    });
                }
                nextArgIndex++;
            }
            links.push({
                callName: callCtx?.funcName || '',
                formatArgIndex: argIndex,
                placeholder,
                args: consumedArgs
            });
        }
    }
    return links;
}

function isOffsetInsideRange(offset, startOffset, endOffset) {
    return Number.isInteger(offset) &&
        Number.isInteger(startOffset) &&
        Number.isInteger(endOffset) &&
        offset >= startOffset &&
        offset < endOffset;
}

function findFormatPlaceholderLinkAtOffset(source, callCtx, offset, options = {}) {
    const links = collectFormatArgumentLinksForCall(source, callCtx, options);
    return links.find(link =>
        isOffsetInsideRange(offset, link.placeholder.startOffset, link.placeholder.endOffset)
    ) || null;
}

module.exports = {
    collectFormatArgumentLinksForCall,
    collectFormatPlaceholdersInArgument,
    collectFormatPlaceholdersInStringRange,
    findFormatPlaceholderLinkAtOffset,
    findStringLiteralRanges,
    FORMAT_SPECIFIER_VALUE_CONSUME_COUNTS,
    getCallArgumentPieces,
    readFormatPlaceholder
};
