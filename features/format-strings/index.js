const { findFormatPlaceholderLinkAtOffset } = require('../../core/format-strings');

function createFormatStringFeature(deps) {
    const {
        vscode,
        getPawnDocumentContext,
        getDocumentTextAndResolver,
        findCallContext,
        findMatchingParenOffset,
        splitTopLevelWithRanges,
        isEscapedQuote,
        createLazyCallContextOptions = null
    } = deps;

    function makeRange(document, startOffset, endOffset) {
        if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset <= startOffset) return null;
        return new vscode.Range(
            document.positionAt(startOffset),
            document.positionAt(endOffset)
        );
    }

    function findPlaceholderLink(document, position) {
        const lineText = String(document?.lineAt?.(position.line)?.text || '');
        if (!lineText.includes('%')) return null;

        const ctx = typeof getPawnDocumentContext === 'function'
            ? getPawnDocumentContext(document, position.line)
            : null;
        const { text, resolver } = getDocumentTextAndResolver(document);
        const callContextOptions = typeof createLazyCallContextOptions === 'function'
            ? createLazyCallContextOptions(document, ctx?.semanticSession || null)
            : {};
        const callCtx = findCallContext(document, position, callContextOptions);
        if (!callCtx?.funcName) return null;

        const offset = document.offsetAt(position);
        const escapeChar = resolver?.ctrlCharAtLine?.(position.line) || '';
        return findFormatPlaceholderLinkAtOffset(text, callCtx, offset, {
            splitTopLevelWithRanges,
            findMatchingParenOffset,
            ctrlCharResolver: resolver,
            isEscapedQuote,
            escapeChar
        });
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
