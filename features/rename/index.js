const { createSymbolReferenceCore } = require('../../core/refactor/symbol-references');

function createRenameFeature(deps) {
    const {
        vscode,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        computeFunctionRangeMaps,
        findVariableDeclarationSpanInRange,
        isLinePositionInsideCommentOrString,
        isEscapedQuote,
        isSameFilePath
    } = deps;
    const symbolReferenceCore = createSymbolReferenceCore({
        vscode,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        computeFunctionRangeMaps,
        findVariableDeclarationSpanInRange,
        isLinePositionInsideCommentOrString,
        isEscapedQuote,
        isSameFilePath
    });

    function prepareRename(document, position) {
        try {
            const target = symbolReferenceCore.getRenameTarget(document, position);
            if (!target) return null;
            return {
                range: target.range,
                placeholder: target.name
            };
        } catch (error) {
            console.error('prepareRename:', error);
            return null;
        }
    }

    function provideRenameEdits(document, position, newName) {
        try {
            const normalizedName = String(newName || '').trim();
            if (!symbolReferenceCore.isValidRenameName(normalizedName)) return null;
            const target = symbolReferenceCore.getRenameTarget(document, position);
            if (!target) return null;
            const edit = new vscode.WorkspaceEdit();
            for (const range of target.references || []) {
                edit.replace(document.uri, range, normalizedName);
            }
            return edit;
        } catch (error) {
            console.error('provideRenameEdits:', error);
            return null;
        }
    }

    function register(context) {
        if (typeof vscode.languages.registerRenameProvider !== 'function') return null;
        const provider = vscode.languages.registerRenameProvider('amxxpawn', {
            prepareRename,
            provideRenameEdits
        });
        context.subscriptions.push(provider);
        return provider;
    }

    return {
        register,
        prepareRename,
        provideRenameEdits
    };
}

module.exports = { createRenameFeature };
