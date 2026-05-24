function createDocumentHighlightFeature(deps) {
    const {
        vscode,
        formatStringFeature = null,
        symbolHighlightFeature = null
    } = deps;

    function provideDocumentHighlights(document, position) {
        const formatHighlights =
            formatStringFeature?.provideDocumentHighlights?.(document, position) || [];
        if (formatHighlights.length) return formatHighlights;
        return symbolHighlightFeature?.provideDocumentHighlights?.(document, position) || [];
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
        provideDocumentHighlights,
        register
    };
}

module.exports = { createDocumentHighlightFeature };
