const COMPLETION_TRIGGER_CHARACTERS = [
    '_',
    '@',
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
];
const PAWN_COMPLETION_WORD_RE = /[A-Za-z_@][A-Za-z0-9_@]*/;

function createCompletionFeature(deps) {
    const {
        vscode,
        t,
        getPawnDocumentContext,
        splitTopLevel,
        isFunctionLikeDecl,
        isFunctionLikeDefineDecl,
        isSameFilePath,
        BUILTIN_DECLS,
        buildSig,
        buildCommandLink,
        isCompletionEnabled = () => true,
        completionOutputChannel = null
    } = deps;

    const logCompletion = message => {
        try {
            completionOutputChannel?.appendLine?.(`[completion] ${message}`);
        } catch {
            // Completion must never fail because logging failed.
        }
    };

    function getCompletionTypeLabel(data) {
        if (data.isArg) return t('completion.type.arg');
        switch (data.type) {
            case 'enum-item': return t('completion.type.enumMember');
            case 'builtin': return t('completion.type.compiler');
            default: return data.type;
        }
    }

    function getCompletionDetailLabel(data, currentFilePath = '') {
        const isLocal = data.isArg || data.isLocal;
        const isCurrentFile = isSameFilePath(data.filePath, currentFilePath);
        const typeLabel = getCompletionTypeLabel(data);
        if (data.type === 'builtin') return t('hover.kind.compiler');
        if (isLocal || isCurrentFile || !data.file) return typeLabel;
        return `${data.file} · ${typeLabel}`;
    }

    function makeItem(data, sortPrefix, currentFilePath = '', replaceRange = null) {
        const { name } = data;
        const isDefineFunc = isFunctionLikeDefineDecl(data);
        const isFunc = isFunctionLikeDecl(data);
        const argPieces = isFunc ? splitTopLevel(data.args || '') : [];

        const item = new vscode.CompletionItem(name);

        const kindMap = {
            native: vscode.CompletionItemKind.Function,
            stock: vscode.CompletionItemKind.Method,
            public: vscode.CompletionItemKind.Interface,
            forward: vscode.CompletionItemKind.Event,
            static: vscode.CompletionItemKind.Method,
            function: vscode.CompletionItemKind.Function,
            enum: vscode.CompletionItemKind.Enum,
            variable: vscode.CompletionItemKind.Variable,
            'enum-item': vscode.CompletionItemKind.EnumMember,
            define: isDefineFunc ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Constant,
            builtin: data.args ? vscode.CompletionItemKind.Keyword : vscode.CompletionItemKind.Constant
        };

        item.kind = kindMap[data.type] ?? vscode.CompletionItemKind.Text;
        item.filterText = name;
        item.sortText = `${sortPrefix}_${name}`;
        item.detail = getCompletionDetailLabel(data, currentFilePath);
        item.label = { label: name, description: item.detail };
        item.labelDetails = { description: item.detail };
        if (replaceRange) item.range = replaceRange;

        item.insertText = isFunc
            ? new vscode.SnippetString(
                name + '(' +
                argPieces.map((a, idx) => `\${${idx + 1}:${a.trim()}}`).join(', ') +
                ')')
            : name;

        item._pawnData = data;
        item._pawnCurrentFilePath = currentFilePath;
        return item;
    }

    function padSortNumber(value, width) {
        const safeValue = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
        return String(safeValue).padStart(width, '0');
    }

    function isMicroScopeLocal(localDecl) {
        if (!localDecl) return false;
        if (localDecl.isForVar) return true;
        const declDepth = Number.isInteger(localDecl.declDepth) ? localDecl.declDepth : 0;
        return declDepth > 1;
    }

    function getScopedLocalSortPrefix(localDecl, cursorLine) {
        const declLine = Number.isInteger(localDecl?.lineNumber) ? localDecl.lineNumber : 0;
        const declDepth = Number.isInteger(localDecl?.declDepth) ? localDecl.declDepth : 0;
        const scopeEndLine = Number.isInteger(localDecl?.scopeEndLine) ? localDecl.scopeEndLine : declLine;
        const lineDistance = Number.isInteger(cursorLine)
            ? Math.max(0, cursorLine - declLine)
            : 0;
        const scopeSpan = Math.max(0, scopeEndLine - declLine);
        const forScopeRank = localDecl?.isForVar ? 0 : 1;
        const depthRank = Math.max(0, 999 - Math.min(999, Math.max(0, declDepth)));
        const baseRank = isMicroScopeLocal(localDecl) ? '001' : '002';

        return [
            baseRank,
            padSortNumber(depthRank, 3),
            padSortNumber(forScopeRank, 1),
            padSortNumber(scopeSpan, 6),
            padSortNumber(lineDistance, 6)
        ].join('_');
    }

    function setBestCompletionCandidate(map, decl, sortPrefix) {
        if (!decl?.name) return;
        const previous = map.get(decl.name);
        if (!previous || String(sortPrefix).localeCompare(String(previous.p)) < 0) {
            map.set(decl.name, { d: decl, p: sortPrefix });
        }
    }

    function getCompletionReplaceRange(document, position) {
        if (!document || !position) return null;
        try {
            const wordRange = document.getWordRangeAtPosition?.(position, PAWN_COMPLETION_WORD_RE);
            if (wordRange) return wordRange;
        } catch {
            // Fall through to the zero-width range.
        }
        try {
            return new vscode.Range(position, position);
        } catch {
            return null;
        }
    }

    function getCompletionItemFilterText(item) {
        const label = typeof item?.label === 'string'
            ? item.label
            : item?.label?.label;
        return String(item?.filterText || label || '').toLowerCase();
    }

    function filterCompletionItemsForPrefix(items, prefix) {
        const normalizedPrefix = String(prefix || '').toLowerCase();
        if (!normalizedPrefix) {
            return {
                items,
                startsWithCount: items.length,
                containsCount: items.length,
                mode: 'all'
            };
        }
        const startsWith = [];
        const contains = [];
        for (const item of items) {
            const text = getCompletionItemFilterText(item);
            if (!text) continue;
            if (text.startsWith(normalizedPrefix)) {
                startsWith.push(item);
            } else if (text.includes(normalizedPrefix)) {
                contains.push(item);
            }
        }
        if (startsWith.length) {
            return {
                items: startsWith,
                startsWithCount: startsWith.length,
                containsCount: startsWith.length + contains.length,
                mode: 'startsWith'
            };
        }
        return {
            items: contains,
            startsWithCount: 0,
            containsCount: contains.length,
            mode: 'contains'
        };
    }

    const completionProvider = {
        provideCompletionItems(document, position) {
            try {
                const fileName = String(document?.fileName || '');
                const line = Number.isInteger(position?.line) ? position.line : -1;
                const character = Number.isInteger(position?.character) ? position.character : -1;
                if (!isCompletionEnabled()) {
                    logCompletion(`skip disabled file=${fileName}`);
                    return [];
                }
                const ctx = getPawnDocumentContext(document, position.line);
                if (!ctx) {
                    logCompletion(`no-context file=${fileName} pos=${line}:${character} lang=${document?.languageId || ''}`);
                    return [];
                }
                const replaceRange = getCompletionReplaceRange(document, position);
                const prefix = replaceRange ? document.getText(replaceRange) : '';
                const { fp, parsedDecls, incDecls, lookup } = ctx;
                const { globals, functions, locals, funcArgs } = parsedDecls;

                const items = [];
                const varMap = new Map();
                for (const d of BUILTIN_DECLS) {
                    setBestCompletionCandidate(varMap, d, '006');
                }
                for (const d of incDecls) {
                    if (d.type === 'variable' || d.type === 'define' || d.type === 'enum-item' || d.type === 'enum') {
                        setBestCompletionCandidate(varMap, d, '005');
                    }
                }
                globals.forEach(d => setBestCompletionCandidate(varMap, d, '004'));
                locals.forEach(d => setBestCompletionCandidate(varMap, { ...d, isLocal: true }, getScopedLocalSortPrefix(d, line)));
                funcArgs.forEach(d => setBestCompletionCandidate(varMap, d, '003'));
                varMap.forEach(({ d, p }) => items.push(makeItem(d, p, fp, replaceRange)));

                functions.forEach(d => items.push(makeItem(d, '010', fp, replaceRange)));
                for (const d of incDecls) {
                    if (d.type !== 'variable' && d.type !== 'enum-item' && d.type !== 'enum' && d.type !== 'define') {
                        if (isFunctionLikeDecl(d)) {
                            const preferredIncludeFunc = lookup.getPreferredFunctionMatch(d.name)?.data || null;
                            if (preferredIncludeFunc && preferredIncludeFunc !== d) continue;
                        }
                        items.push(makeItem(d, '011', fp, replaceRange));
                    }
                }

                const filtered = filterCompletionItemsForPrefix(items, prefix);

                logCompletion(
                    `items=${filtered.items.length}/${items.length} prefix="${prefix}" mode=${filtered.mode} ` +
                    `startsWith=${filtered.startsWithCount} contains=${filtered.containsCount} ` +
                    `file=${fileName} pos=${line}:${character} ` +
                    `globals=${globals.length} locals=${locals.length} args=${funcArgs.length} ` +
                    `functions=${functions.length} includes=${incDecls.length}`
                );
                return typeof vscode.CompletionList === 'function'
                    ? new vscode.CompletionList(filtered.items, !!prefix)
                    : filtered.items;
            } catch (error) {
                logCompletion(`error ${error?.stack || String(error)}`);
                console.error('AMXX Pawn completion provider failed:', error);
                return [];
            }
        },

        resolveCompletionItem(item) {
            try {
                if (!isCompletionEnabled()) return item;
                const data = item._pawnData;
                if (!data) return item;
                const currentFilePath = item._pawnCurrentFilePath || '';
                const md = new vscode.MarkdownString();
                md.isTrusted = true;
                md.supportHtml = true;
                const signature = buildSig(data);
                if (signature) {
                    md.appendCodeblock(signature, 'amxxpawn');
                }
                if (data.type === 'builtin') {
                    md.appendMarkdown(`**${t('completion.detail.source')}:** ${t('hover.kind.compiler')}\n\n`);
                } else if (data.file && !isSameFilePath(data.filePath, currentFilePath)) {
                    md.appendMarkdown(`**${t('completion.detail.file')}:** \`${data.file}\`\n\n`);
                }
                if (data.filePath && !data.isArg && !data.isLocal) {
                    md.appendMarkdown(buildCommandLink(t('hover.goToDefinition'), data.filePath, data.lineNumber) + '\n\n');
                }
                const docsText = data.docs || data.enumDocs || '';
                if (docsText) md.appendMarkdown(`\n\n### ${t('hover.description')}\n${docsText}`);
                item.documentation = md;
            } catch (error) {
                console.error('AMXX Pawn completion resolve failed:', error);
            }
            return item;
        }
    };

    return {
        provideCompletionItems: completionProvider.provideCompletionItems,
        resolveCompletionItem: completionProvider.resolveCompletionItem,
        register(context) {
            context.subscriptions.push(
                vscode.languages.registerCompletionItemProvider(
                    'amxxpawn',
                    completionProvider,
                    ...COMPLETION_TRIGGER_CHARACTERS
                )
            );
        }
    };
}

module.exports = {
    COMPLETION_TRIGGER_CHARACTERS,
    createCompletionFeature
};
