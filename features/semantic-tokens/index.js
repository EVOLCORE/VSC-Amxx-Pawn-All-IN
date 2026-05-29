const {
    collectNumericDefineNamesFromContext,
    findNumericDefineNameRangesInLine
} = require('../../core/syntax/numeric-defines');
const { isPreprocessorDirectiveNamedLine } = require('../../core/syntax/preprocessor-directive-context');

const SEMANTIC_TOKEN_TYPES = ['number', 'function'];
const SEMANTIC_TOKEN_MODIFIERS = ['declaration'];
const NUMBER_TOKEN_TYPE_INDEX = 0;
const FUNCTION_TOKEN_TYPE_INDEX = 1;
const DECLARATION_TOKEN_MODIFIER_MASK = 1 << 0;

function createSemanticTokensFeature(deps) {
    const {
        vscode,
        getPawnDocumentContext,
        isLinePositionInsideCommentOrString
    } = deps;

    const createLegend = () => {
        if (typeof vscode?.SemanticTokensLegend !== 'function') return null;
        return new vscode.SemanticTokensLegend(SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS);
    };
    const legend = createLegend();

    function findFunctionDeclarationNameRange(ctx, decl) {
        const name = String(decl?.name || '').trim();
        const lineNumber = decl?.startLine ?? decl?.lineNumber;
        if (!name || !Number.isInteger(lineNumber)) return null;
        const rawLine = String(ctx?.rawLines?.[lineNumber] || '');
        const scanLine = String(ctx?.strippedLines?.[lineNumber] || rawLine);
        const openIndex = scanLine.indexOf('(');
        const searchEnd = openIndex >= 0 ? openIndex : scanLine.length;
        const start = scanLine.lastIndexOf(name, searchEnd);
        if (start < 0) return null;
        const end = start + name.length;
        if (end > rawLine.length) return null;
        return { lineNumber, start, end };
    }

    function pushFunctionDeclarationTokens(builder, ctx) {
        const functions = ctx?.parsedDecls?.functions || [];
        if (!Array.isArray(functions) || !functions.length) return;
        const seen = new Set();
        for (const decl of functions) {
            if (!decl?.name || decl.type === 'define') continue;
            const range = findFunctionDeclarationNameRange(ctx, decl);
            if (!range) continue;
            const key = `${range.lineNumber}:${range.start}:${range.end}`;
            if (seen.has(key)) continue;
            seen.add(key);
            builder.push(
                range.lineNumber,
                range.start,
                range.end - range.start,
                FUNCTION_TOKEN_TYPE_INDEX,
                DECLARATION_TOKEN_MODIFIER_MASK
            );
        }
    }

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
            pushFunctionDeclarationTokens(builder, ctx);
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
