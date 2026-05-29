const { createSymbolReferenceCore } = require('../../core/refactor/symbol-references');

function createSymbolHighlightFeature(deps) {
    const {
        vscode,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        computeFunctionRangeMaps,
        findVariableDeclarationSpanInRange,
        isLinePositionInsideCommentOrString,
        isEscapedQuote,
        isSameFilePath,
        splitTopLevel,
        parseParamMeta,
        isFunctionLikeDecl,
        symbolReferenceCore: providedSymbolReferenceCore = null
    } = deps;
    const symbolReferenceCore = providedSymbolReferenceCore || createSymbolReferenceCore({
        vscode,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        computeFunctionRangeMaps,
        findVariableDeclarationSpanInRange,
        isLinePositionInsideCommentOrString,
        isEscapedQuote,
        isSameFilePath,
        splitTopLevel,
        parseParamMeta,
        isFunctionLikeDecl
    });

    function hasPawnIdentifierAtPosition(document, position) {
        const lineText = String(document?.lineAt?.(position?.line)?.text || '');
        const index = Math.max(0, Math.min(lineText.length, position?.character ?? 0));
        const isIdent = char => /[A-Za-z0-9_@]/.test(String(char || ''));
        return isIdent(lineText[index]) || isIdent(lineText[index - 1]);
    }

    function createDocumentHighlight(range) {
        if (!range) return null;
        const kind = vscode.DocumentHighlightKind?.Text;
        if (typeof vscode.DocumentHighlight === 'function') {
            return new vscode.DocumentHighlight(range, kind);
        }
        return { range, kind };
    }

    function provideDocumentHighlights(document, position) {
        try {
            if (!hasPawnIdentifierAtPosition(document, position)) return [];
            const target = symbolReferenceCore.getRenameTarget(document, position);
            if (!target?.references?.length) return [];
            const highlights = [];
            const seen = new Set();
            for (const range of target.references) {
                const key = [
                    range?.start?.line,
                    range?.start?.character,
                    range?.end?.line,
                    range?.end?.character
                ].join(':');
                if (seen.has(key)) continue;
                seen.add(key);
                const highlight = createDocumentHighlight(range);
                if (highlight) highlights.push(highlight);
            }
            return highlights;
        } catch (error) {
            console.error('provideSymbolDocumentHighlights:', error);
            return [];
        }
    }

    return {
        provideDocumentHighlights
    };
}

module.exports = { createSymbolHighlightFeature };
