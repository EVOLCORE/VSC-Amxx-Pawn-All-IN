const COMPOUND_PAWN_ASSIGNMENT_OPERATORS = new Set([
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '&=',
    '|=',
    '^='
]);

function isPawnAssignmentCompareNeighbor(source = '', index = 0) {
    const text = String(source || '');
    const cursor = Math.max(0, Number.isInteger(index) ? index : 0);
    const previous = text[cursor - 1] || '';
    const next = text[cursor + 1] || '';
    return previous === '=' ||
        previous === '!' ||
        previous === '<' ||
        previous === '>' ||
        next === '=';
}

function readPawnAssignmentOperatorAt(source = '', index = 0, options = {}) {
    const text = String(source || '');
    const cursor = Math.max(0, Number.isInteger(index) ? index : 0);
    const three = text.slice(cursor, cursor + 3);
    if (three === '<<=' || three === '>>=') return three;
    const two = text.slice(cursor, cursor + 2);
    if (COMPOUND_PAWN_ASSIGNMENT_OPERATORS.has(two)) return two;
    if (text[cursor] !== '=') return '';
    if (options.allowComparisonLike === true || !isPawnAssignmentCompareNeighbor(text, cursor)) {
        return '=';
    }
    return '';
}

module.exports = {
    COMPOUND_PAWN_ASSIGNMENT_OPERATORS,
    isPawnAssignmentCompareNeighbor,
    readPawnAssignmentOperatorAt
};
