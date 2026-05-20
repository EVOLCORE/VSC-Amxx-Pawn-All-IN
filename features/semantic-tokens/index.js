const {
    collectNumericDefineNamesFromContext,
    findNumericDefineNameRangesInLine
} = require('../../core/syntax/numeric-defines');
const { isPreprocessorDirectiveNamedLine } = require('../../core/syntax/preprocessor-directives');

const SEMANTIC_TOKEN_TYPES = ['number'];
const NUMBER_TOKEN_TYPE_INDEX = 0;

function createSemanticTokensFeature(deps) {
    const {
        vscode,
        getPawnDocumentContext,
        isLinePositionInsideCommentOrString
    } = deps;

    const createLegend = () => {
        if (typeof vscode?.SemanticTokensLegend !== 'function') return null;
        return new vscode.SemanticTokensLegend(SEMANTIC_TOKEN_TYPES, []);
    };
    const legend = createLegend();

    function shouldSkipRange(rawLine, lineNumber, range, ctx) {
        if (!range) return true;
        const trimmed = String(rawLine || '').trimStart();
        if (isPreprocessorDirectiveNamedLine(trimmed, 'define')) return true;
        const escapeChar = ctx?.resolver?.ctrlCharAtLine?.(lineNumber) || ctx?.lineCtrlChars?.[lineNumber] || undefined;
        return typeof isLinePositionInsideCommentOrString === 'function' &&
            isLinePositionInsideCommentOrString(rawLine, range.start, escapeChar);
    }

    function provideDocumentSemanticTokens(document) {
        try {
            if (!legend || typeof vscode?.SemanticTokensBuilder !== 'function') return null;
            const ctx = getPawnDocumentContext(document, undefined);
            if (!ctx) return null;

            const numericDefineNames = collectNumericDefineNamesFromContext(ctx);
            const builder = new vscode.SemanticTokensBuilder(legend);
            if (!numericDefineNames.size) return builder.build();

            const rawLines = ctx.rawLines || [];
            const strippedLines = ctx.strippedLines || rawLines;
            for (let lineNumber = 0; lineNumber < strippedLines.length; lineNumber++) {
                const rawLine = String(rawLines[lineNumber] || '');
                const scanLine = String(strippedLines[lineNumber] || '');
                if (!scanLine) continue;
                for (const range of findNumericDefineNameRangesInLine(scanLine, numericDefineNames)) {
                    if (shouldSkipRange(rawLine, lineNumber, range, ctx)) continue;
                    builder.push(lineNumber, range.start, range.end - range.start, NUMBER_TOKEN_TYPE_INDEX, 0);
                }
            }

            return builder.build();
        } catch (error) {
            console.error('provideDocumentSemanticTokens:', error);
            return null;
        }
    }

    function register(context) {
        if (!legend || typeof vscode?.languages?.registerDocumentSemanticTokensProvider !== 'function') return null;
        const provider = vscode.languages.registerDocumentSemanticTokensProvider(
            'amxxpawn',
            { provideDocumentSemanticTokens },
            legend
        );
        context?.subscriptions?.push?.(provider);
        return provider;
    }

    return {
        legend,
        register,
        provideDocumentSemanticTokens
    };
}

module.exports = {
    SEMANTIC_TOKEN_TYPES,
    createSemanticTokensFeature
};
