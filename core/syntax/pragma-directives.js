const {
    normalizePreprocessorDirectiveName,
    readPreprocessorDirectiveNameContext,
    readPreprocessorIdentifierToken,
    skipPreprocessorIdentifierWhitespace
} = require('./preprocessor-directive-context');

function parsePragmaDirectiveLine(line = '') {
    const source = String(line || '');
    const directive = readPreprocessorDirectiveNameContext(source);
    if (!directive || directive.directiveName !== 'pragma') return null;

    const token = readPreprocessorIdentifierToken(source, directive.tokenEnd);
    const nameStart = token?.start ?? skipPreprocessorIdentifierWhitespace(source, directive.tokenEnd);
    const nameEnd = token?.end ?? nameStart;

    const name = normalizePreprocessorDirectiveName(token?.name ?? '');
    const valueStart = nameEnd;
    return {
        name,
        nameStart,
        nameEnd,
        value: source.slice(valueStart).trim(),
        valueStart,
        directive
    };
}

module.exports = { parsePragmaDirectiveLine };
