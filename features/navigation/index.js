function createNavigationFeature(deps) {
    const {
        vscode,
        t,
        normalizeFsPath,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        findHeaderFunctionByNameAtPosition,
        findDefinitionContext,
        hasIncludeFunctionTwin,
        getPreferredFunctionHoverMatch,
        findFirstNavigableDecl
    } = deps;

    function provideDefinition(document, position) {
        try {
            const ctx = getPawnDocumentContext(document, position.line);
            if (!ctx) return null;
            const token = getLookupTokenAtPosition(document, position, { ctrlCharResolver: ctx.resolver });
            if (!token?.text) return null;
            const word = token.text;
            const { parsedDecls, incDecls, lookup } = ctx;
            const { functions } = parsedDecls;
            const declarationNameCtx = findHeaderFunctionByNameAtPosition(document, position, functions, ctx.resolver);
            const definitionCtx = findDefinitionContext(document, position, functions);

            const headerFuncName = declarationNameCtx?.name || definitionCtx?.funcName || '';
            if (headerFuncName && hasIncludeFunctionTwin(headerFuncName, incDecls, lookup)) {
                const includeHeaderMatch = getPreferredFunctionHoverMatch(
                    headerFuncName,
                    functions,
                    incDecls,
                    { preferInclude: true },
                    lookup
                )?.data || null;
                if (includeHeaderMatch?.filePath) {
                    return new vscode.Location(
                        vscode.Uri.file(includeHeaderMatch.filePath),
                        new vscode.Position(includeHeaderMatch.lineNumber, 0)
                    );
                }
            }

            const targetMatch = findFirstNavigableDecl(lookup, word);
            if (!targetMatch) return null;

            return new vscode.Location(
                vscode.Uri.file(targetMatch.filePath),
                new vscode.Position(targetMatch.lineNumber, 0)
            );
        } catch (err) {
            console.error('provideDefinition:', err);
            return null;
        }
    }

    function register(context) {
        context.subscriptions.push(
            vscode.commands.registerCommand('amxxPawnAllIn.goToLocation', async (filePath, lineNumber) => {
                try {
                    const uri = vscode.Uri.file(filePath);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc, {
                        selection: new vscode.Range(lineNumber, 0, lineNumber, 0),
                        viewColumn: vscode.ViewColumn.Active,
                        preview: false
                    });
                } catch {
                    vscode.window.showErrorMessage(t('common.cannotOpenFile', { filePath }));
                }
            })
        );

        context.subscriptions.push(
            vscode.languages.registerDefinitionProvider('amxxpawn', {
                provideDefinition
            })
        );
    }

    return {
        register,
        provideDefinition
    };
}

module.exports = { createNavigationFeature };
