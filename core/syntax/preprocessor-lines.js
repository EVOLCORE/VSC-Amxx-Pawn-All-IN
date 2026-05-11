const { skipPawnHorizontalWhitespace } = require('./whitespace');

function getPreprocessorDirectiveStartIndex(line = '') {
    const source = String(line || '');
    const index = skipPawnHorizontalWhitespace(source, 0);
    return index < source.length && source.charCodeAt(index) === 35 ? index : -1;
}

function isPreprocessorDirectiveLine(line = '') {
    return getPreprocessorDirectiveStartIndex(line) >= 0;
}

module.exports = {
    getPreprocessorDirectiveStartIndex,
    isPreprocessorDirectiveLine
};
