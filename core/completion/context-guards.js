const isAsciiDigit = char => char >= '0' && char <= '9';

const isNumericLiteralTailChar = char =>
    !!char && (
        (char >= '0' && char <= '9') ||
        (char >= 'a' && char <= 'z') ||
        (char >= 'A' && char <= 'Z') ||
        char === '_' ||
        char === '@' ||
        char === '.'
    );

function clampCharacter(character, length) {
    const number = Number.isInteger(character) ? character : 0;
    return Math.max(0, Math.min(length, number));
}

function getRangeCharacter(range, edge) {
    const position = edge === 'end' ? range?.end : range?.start;
    return Number.isInteger(position?.character) ? position.character : null;
}

function isNumericLiteralCompletionPosition(lineText, character, replaceRange = null) {
    const text = String(lineText || '');
    const cursor = clampCharacter(character, text.length);
    const rangeStartValue = getRangeCharacter(replaceRange, 'start');
    const rangeStart = rangeStartValue == null
        ? cursor
        : clampCharacter(rangeStartValue, text.length);

    if (rangeStart < cursor) {
        if (isAsciiDigit(text[rangeStart] || '')) return true;
        return rangeStart > 0 && isAsciiDigit(text[rangeStart - 1] || '');
    }

    if (cursor <= 0) return false;
    const previous = text[cursor - 1] || '';
    if (!isAsciiDigit(previous) && previous !== '.') return false;
    if (previous === '.' && !isAsciiDigit(text[cursor - 2] || '')) return false;

    let tokenStart = cursor;
    while (tokenStart > 0 && isNumericLiteralTailChar(text[tokenStart - 1] || '')) {
        tokenStart--;
    }
    return isAsciiDigit(text[tokenStart] || '');
}

module.exports = {
    isNumericLiteralCompletionPosition
};
