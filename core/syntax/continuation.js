const { findPawnLineTrimEndIndex } = require('./whitespace');

function getTrimmedLineEnd(source = '') {
    return findPawnLineTrimEndIndex(String(source || ''), 0, { allowCarriageReturn: true });
}

function hasTrailingBackslashContinuation(source = '') {
    const text = String(source || '');
    const end = getTrimmedLineEnd(text);
    return end > 0 && text.charCodeAt(end - 1) === 92;
}

function countTrailingBackslashes(source = '') {
    const text = String(source || '');
    let cursor = getTrimmedLineEnd(text) - 1;
    let count = 0;
    while (cursor >= 0 && text.charCodeAt(cursor) === 92) {
        count++;
        cursor--;
    }
    return count;
}

function hasOddTrailingBackslashContinuation(source = '') {
    const count = countTrailingBackslashes(source);
    return count > 0 && (count % 2) === 1;
}

function removeTrailingBackslashContinuation(source = '') {
    const text = String(source || '');
    if (!hasTrailingBackslashContinuation(text)) return text;
    const end = getTrimmedLineEnd(text);
    return text.slice(0, end - 1) + text.slice(end);
}

module.exports = {
    countTrailingBackslashes,
    hasOddTrailingBackslashContinuation,
    hasTrailingBackslashContinuation,
    removeTrailingBackslashContinuation
};
