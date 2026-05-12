const { parsePawnIncludeDirectiveTarget } = require('../../core/syntax/includes');

function createNavigationFeature(deps) {
    const {
        vscode,
        t,
        normalizeFsPath,
        getSearchPaths,
        resolveInclude,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        findHeaderFunctionByNameAtPosition,
        findDefinitionContext,
        hasIncludeFunctionTwin,
        getPreferredFunctionHoverMatch,
        findFirstNavigableDecl
    } = deps;

    function findIncludeTargetOnLine(lineText, lineNumber) {
        const text = String(lineText || '');
        const target = parsePawnIncludeDirectiveTarget(text);
        if (!target) return null;

        return {
            name: target.name,
            range: new vscode.Range(lineNumber, target.nameStart, lineNumber, target.nameEnd),
            clickRange: new vscode.Range(lineNumber, target.tokenStart, lineNumber, target.tokenEnd)
        };
    }

    function isPositionInsideLineRange(position, range) {
        return !!position &&
            !!range &&
            position.line === range.start.line &&
            position.character >= range.start.character &&
            position.character <= range.end.character;
    }

    function getIncludeTargetAtPosition(document, position) {
        if (!document || !position || position.line < 0 || position.line >= document.lineCount) return null;
        const target = findIncludeTargetOnLine(document.lineAt(position.line)?.text || '', position.line);
        return isPositionInsideLineRange(position, target?.clickRange) ? target : null;
    }

    function resolveIncludeFilePath(document, includeName, searchPaths = null) {
        if (!includeName || typeof resolveInclude !== 'function') return '';
        const paths = Array.isArray(searchPaths)
            ? searchPaths
            : (typeof getSearchPaths === 'function' ? getSearchPaths(document?.fileName || '') : []);
        return resolveInclude(includeName, paths, document?.fileName || '') || '';
    }

    function createIncludeLocation(filePath) {
        if (!filePath) return null;
        return new vscode.Location(
            vscode.Uri.file(filePath),
            new vscode.Position(0, 0)
        );
    }

    function provideIncludeDefinition(document, position) {
        const target = getIncludeTargetAtPosition(document, position);
        if (!target) return null;
        return createIncludeLocation(resolveIncludeFilePath(document, target.name));
    }

    function provideDefinition(document, position) {
        try {
            const includeLocation = provideIncludeDefinition(document, position);
            if (includeLocation) return includeLocation;

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
            const getIncludeHeaderMatch = name => {
                if (!name || !hasIncludeFunctionTwin(name, incDecls, lookup)) return null;
                return getPreferredFunctionHoverMatch(
                    name,
                    functions,
                    incDecls,
                    { preferInclude: true },
                    lookup
                )?.data || null;
            };
            const includeHeaderMatch = (() => {
                const exactMatch = getIncludeHeaderMatch(headerFuncName);
                if (exactMatch) return exactMatch;
                const text = String(headerFuncName || '');
                if (!text.startsWith('@') || text.length <= 1) return null;
                return getIncludeHeaderMatch(text.slice(1));
            })();
            if (includeHeaderMatch?.filePath) {
                return new vscode.Location(
                    vscode.Uri.file(includeHeaderMatch.filePath),
                    new vscode.Position(includeHeaderMatch.lineNumber, 0)
                );
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

    function provideDocumentLinks(document) {
        try {
            if (!document || typeof vscode.DocumentLink !== 'function') return [];
            const searchPaths = typeof getSearchPaths === 'function' ? getSearchPaths(document.fileName || '') : [];
            const links = [];
            for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
                const target = findIncludeTargetOnLine(document.lineAt(lineNumber)?.text || '', lineNumber);
                if (!target) continue;

                const filePath = resolveIncludeFilePath(document, target.name, searchPaths);
                if (!filePath) continue;
                links.push(new vscode.DocumentLink(target.range, vscode.Uri.file(filePath)));
            }
            return links;
        } catch (err) {
            console.error('provideDocumentLinks:', err);
            return [];
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

        if (typeof vscode.languages.registerDocumentLinkProvider === 'function') {
            context.subscriptions.push(
                vscode.languages.registerDocumentLinkProvider('amxxpawn', {
                    provideDocumentLinks
                })
            );
        }
    }

    return {
        register,
        provideDefinition,
        provideDocumentLinks
    };
}

module.exports = { createNavigationFeature };
