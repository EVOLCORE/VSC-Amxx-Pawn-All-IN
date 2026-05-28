const { createFormatPlaceholderResolver } = require('./resolver');

function createFormatStringFeature(deps) {
    const { vscode } = deps;
    const formatPlaceholderResolver = createFormatPlaceholderResolver(deps);

    function makeRange(document, startOffset, endOffset) {
        if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset <= startOffset) return null;
        return new vscode.Range(
            document.positionAt(startOffset),
            document.positionAt(endOffset)
        );
    }

    function findPlaceholderLink(document, position) {
        return formatPlaceholderResolver.findPlaceholderLink(document, position);
    }

    function provideDocumentHighlights(document, position) {
        try {
            const link = findPlaceholderLink(document, position);
            if (!link) return [];

            const ranges = [];
            const placeholderRange = makeRange(
                document,
                link.placeholder.startOffset,
                link.placeholder.endOffset
            );
            if (placeholderRange) {
                ranges.push(new vscode.DocumentHighlight(
                    placeholderRange,
                    vscode.DocumentHighlightKind?.Text
                ));
            }

            for (const arg of link.args || []) {
                const argRange = makeRange(document, arg.startOffset, arg.endOffset);
                if (!argRange) continue;
                ranges.push(new vscode.DocumentHighlight(
                    argRange,
                    vscode.DocumentHighlightKind?.Read
                ));
            }

            return ranges;
        } catch (error) {
            console.error('provideFormatStringDocumentHighlights:', error);
            return [];
        }
    }

    function register(context) {
        if (typeof vscode?.languages?.registerDocumentHighlightProvider !== 'function') return null;
        const provider = vscode.languages.registerDocumentHighlightProvider('amxxpawn', {
            provideDocumentHighlights
        });
        context?.subscriptions?.push?.(provider);
        return provider;
    }

    return {
        findPlaceholderLink,
        provideDocumentHighlights,
        register
    };
}

module.exports = { createFormatStringFeature };
