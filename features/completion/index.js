const {
    getCompletionControlContext,
    getCompletionIntent
} = require('../../core/syntax/control-context');
const { createCompletionInsertTextCore } = require('../../core/completion');

const COMPLETION_TRIGGER_CHARACTERS = [
    '_',
    '@',
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
];
const PAWN_COMPLETION_WORD_RE = /[A-Za-z_@][A-Za-z0-9_@]*/;
const COMPLETION_SIGNATURE_WRAP_WIDTH = 96;
const COMPLETION_DOC_WRAP_WIDTH = 88;
const SERVICE_KEYWORD_COMPLETIONS = [
    { name: 'if', detail: 'statement', insertText: 'if (${1:condition}) {\n\t$0\n}', context: 'statement' },
    { name: 'else', detail: 'statement', insertText: 'else {\n\t$0\n}', context: 'else' },
    { name: 'for', detail: 'loop statement', insertText: 'for (new ${1:i} = 0; ${1:i} < ${2:count}; ${1:i}++) {\n\t$0\n}', context: 'statement' },
    { name: 'while', detail: 'loop statement', insertText: 'while (${1:condition}) {\n\t$0\n}', context: 'statement' },
    { name: 'do', detail: 'loop statement', insertText: 'do {\n\t$0\n} while (${1:condition});', context: 'statement' },
    { name: 'switch', detail: 'switch statement', insertText: 'switch (${1:value}) {\n\tcase ${2:0}: {\n\t\t$0\n\t}\n}', context: 'statement' },
    { name: 'case', detail: 'switch label', insertText: 'case ${1:value}: {\n\t$0\n}', context: 'switch-label' },
    { name: 'default', detail: 'switch label', insertText: 'default: {\n\t$0\n}', context: 'switch-label' },
    { name: 'break', detail: 'loop/switch control', insertText: 'break;', context: 'break' },
    { name: 'continue', detail: 'loop control', insertText: 'continue;', context: 'loop' },
    { name: 'return', detail: 'statement', insertText: 'return $0;', context: 'statement' },
    { name: 'goto', detail: 'statement', insertText: 'goto ${1:label};', context: 'statement' },
    { name: 'state', detail: 'statement', insertText: 'state ${1:name};', context: 'statement' },
    { name: 'exit', detail: 'statement', insertText: 'exit;', context: 'statement' }
];

function createCompletionFeature(deps) {
    const {
        vscode,
        t,
        getPawnDocumentContext,
        splitTopLevel,
        parseParamMeta,
        isEscapedQuote,
        isFunctionLikeDecl,
        isFunctionLikeDefineDecl,
        isSameFilePath,
        BUILTIN_DECLS,
        buildSig,
        buildCommandLink,
        classifyPawnStatementLine = null,
        countStructuralBraces = null,
        findFirstNonWhitespaceIndex = null,
        findKeywordOccurrences = null,
        skipInlineControlHeader = null,
        isCompletionEnabled = () => true,
        getForwardCompletionBodyStyle = () => 'same-line',
        completionOutputChannel = null
    } = deps;

    const logCompletion = message => {
        try {
            completionOutputChannel?.appendLine?.(`[completion] ${message}`);
        } catch {
            // Completion must never fail because logging failed.
        }
    };
    const declarationArgSnippetTextCache = new WeakMap();
    const callArgSnippetTextCache = new WeakMap();
    const detailLabelCache = new WeakMap();
    const completionIdentityCache = new WeakMap();
    const baseCandidatesCache = new WeakMap();
    const candidatePrefixFilterCache = new WeakMap();
    const candidateItemsCache = new WeakMap();
    const forwardImplementationDeclMapCache = new WeakMap();
    const forwardImplementationCandidatesCache = new WeakMap();
    const controlContextCache = new WeakMap();
    const completionIntentCache = new WeakMap();
    const MAX_CANDIDATE_ITEM_CACHE_ENTRIES = 16;
    const completionInsertTextCore = createCompletionInsertTextCore({
        splitTopLevel,
        parseParamMeta,
        isEscapedQuote
    });

    function getCompletionTypeLabel(data) {
        if (data.isArg) return t('completion.type.arg');
        switch (data.type) {
            case 'enum-item': return t('completion.type.enumMember');
            case 'builtin': return t('completion.type.compiler');
            default: return data.type;
        }
    }

    function getCompletionDetailLabel(data, currentFilePath = '') {
        if (data && typeof data === 'object') {
            let perFileCache = detailLabelCache.get(data);
            if (!perFileCache) {
                perFileCache = new Map();
                detailLabelCache.set(data, perFileCache);
            }
            const cacheKey = String(currentFilePath || '');
            if (perFileCache.has(cacheKey)) return perFileCache.get(cacheKey);
            const label = getCompletionDetailLabelUncached(data, currentFilePath);
            perFileCache.set(cacheKey, label);
            return label;
        }
        return getCompletionDetailLabelUncached(data, currentFilePath);
    }

    function appendDeprecatedCompletionDetail(label, data) {
        const text = String(label || '').trim();
        if (data?.deprecated !== true) return text;
        if (/\bdeprecated\b/i.test(text)) return text;
        return text ? `${text} · deprecated` : 'deprecated';
    }

    function getCompletionDetailLabelUncached(data, currentFilePath = '') {
        const isLocal = data.isArg || data.isLocal;
        const isCurrentFile = isSameFilePath(data.filePath, currentFilePath);
        const typeLabel = getCompletionTypeLabel(data);
        if (data.type === 'builtin') {
            return appendDeprecatedCompletionDetail(t('hover.kind.compiler'), data);
        }
        if (isLocal || isCurrentFile || !data.file) {
            return appendDeprecatedCompletionDetail(typeLabel, data);
        }
        return appendDeprecatedCompletionDetail(`${data.file} · ${typeLabel}`, data);
    }

    function normalizeForwardCompletionBodyStyle(value) {
        const text = String(value || '').trim().toLowerCase();
        if (text === 'disabled' || text === 'next-line') return text;
        return 'same-line';
    }

    function getDeclarationArgSnippetText(data) {
        if (!data || typeof data !== 'object') return '';
        if (declarationArgSnippetTextCache.has(data)) return declarationArgSnippetTextCache.get(data);
        const snippetText = completionInsertTextCore.buildDeclarationArgSnippetText(data.args || '');
        declarationArgSnippetTextCache.set(data, snippetText);
        return snippetText;
    }

    function getCallArgSnippetText(data) {
        if (!data || typeof data !== 'object') return '';
        if (callArgSnippetTextCache.has(data)) return callArgSnippetTextCache.get(data);
        const snippetText = completionInsertTextCore.buildCallArgSnippetText(data.args || '');
        callArgSnippetTextCache.set(data, snippetText);
        return snippetText;
    }

    function buildCompletionIdentity(data) {
        const name = data?.name || '';
        const isDefineFunc = isFunctionLikeDefineDecl(data);
        const isFunc = isFunctionLikeDecl(data);
        const callInsertName = isFunc && String(name || '').startsWith('@')
            ? String(name).slice(1)
            : name;
        const filterText = callInsertName === name ? name : `${callInsertName} ${name}`;
        const filterAliases = callInsertName === name ? [name] : [callInsertName, name];
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
            builtin: data?.args ? vscode.CompletionItemKind.Keyword : vscode.CompletionItemKind.Constant
        };
        return {
            name,
            isDefineFunc,
            isFunc,
            callInsertName,
            filterText,
            filterAliases,
            normalizedFilterText: String(filterText || '').toLowerCase(),
            normalizedFilterAliases: filterAliases
                .map(alias => String(alias || '').toLowerCase())
                .filter(Boolean),
            kind: kindMap[data?.type] ?? vscode.CompletionItemKind.Text
        };
    }

    function getCompletionIdentity(data) {
        if (data && typeof data === 'object') {
            const cached = completionIdentityCache.get(data);
            if (cached) return cached;
            const identity = buildCompletionIdentity(data);
            completionIdentityCache.set(data, identity);
            return identity;
        }
        return buildCompletionIdentity(data);
    }

    function getCompletionDataCallInsertName(data) {
        return getCompletionIdentity(data).callInsertName;
    }

    function getCompletionDataFilterText(data) {
        return getCompletionIdentity(data).normalizedFilterText;
    }

    function makeItem(
        data,
        sortPrefix,
        currentFilePath = '',
        replaceRange = null,
        options = {},
        identityOverride = null,
        detailOverride = null
    ) {
        const identity = identityOverride || getCompletionIdentity(data);
        const { name, isFunc, callInsertName } = identity;
        const declarationInsertName = name;
        const useForwardBodySnippet = !!(
            isFunc &&
            data.type === 'forward' &&
            options.forwardBodyStyle &&
            options.forwardBodyStyle !== 'disabled' &&
            options.isForwardImplementationContext
        );

        const item = new vscode.CompletionItem(name);

        item.kind = identity.kind;
        item.filterText = options.prefixStartsWithAt && String(name || '').startsWith('@')
            ? name
            : identity.filterText;
        item.sortText = `${sortPrefix}_${name}`;
        item.detail = detailOverride || getCompletionDetailLabel(data, currentFilePath);
        item.label = { label: name, description: item.detail };
        item.labelDetails = { description: item.detail };
        if (data.deprecated === true && vscode.CompletionItemTag?.Deprecated != null) {
            item.tags = [vscode.CompletionItemTag.Deprecated];
        }
        if (replaceRange) item.range = replaceRange;

        if (isFunc) {
            if (useForwardBodySnippet) {
                item.range = getForwardBodyReplacementRange(replaceRange, options.existingArgumentBlock);
                const argSnippetText = getDeclarationArgSnippetText(data);
                const header = `${declarationInsertName}(${argSnippetText})`;
                item.insertText = new vscode.SnippetString(
                    options.forwardBodyStyle === 'next-line'
                        ? `${header}\n{\n\t$0\n}`
                        : `${header} {\n\t$0\n}`
                );
            } else if (options.callInsertMode === 'name-only') {
                item.insertText = callInsertName;
            } else {
                const argSnippetText = getCallArgSnippetText(data);
                item.insertText = new vscode.SnippetString(`${callInsertName}(${argSnippetText})`);
            }
        } else {
            item.insertText = callInsertName;
        }

        item._pawnData = data;
        item._pawnCurrentFilePath = currentFilePath;
        return item;
    }

    function makeCandidateItem(candidate, currentFilePath = '', replaceRange = null, options = {}) {
        if (!candidate) return null;
        if (candidate.detail == null) {
            candidate.detail = getCompletionDetailLabel(candidate.d, currentFilePath);
        }
        return makeItem(
            candidate.d,
            candidate.p,
            currentFilePath,
            replaceRange,
            options,
            candidate.i,
            candidate.detail
        );
    }

    function getRangeCacheKey(range = null) {
        if (!range?.start || !range?.end) return '';
        return [
            range.start.line,
            range.start.character,
            range.end.line,
            range.end.character
        ].join(':');
    }

    function getCompletionItemCacheKey(currentFilePath = '', replaceRange = null, options = {}) {
        return [
            String(currentFilePath || ''),
            getRangeCacheKey(replaceRange),
            String(options.forwardBodyStyle || ''),
            options.isForwardImplementationContext ? 1 : 0,
            String(options.callInsertMode || ''),
            options.prefixStartsWithAt ? 1 : 0,
            getExistingArgumentBlockCacheKey(options.existingArgumentBlock)
        ].join('|');
    }

    function getCandidateCompletionItems(candidates, currentFilePath = '', replaceRange = null, options = {}) {
        if (!Array.isArray(candidates) || !candidates.length) return [];

        let cache = candidateItemsCache.get(candidates);
        if (!cache) {
            cache = new Map();
            candidateItemsCache.set(candidates, cache);
        }
        const cacheKey = getCompletionItemCacheKey(currentFilePath, replaceRange, options);
        if (cache.has(cacheKey)) return cache.get(cacheKey);
        if (cache.size > MAX_CANDIDATE_ITEM_CACHE_ENTRIES) cache.clear();

        const items = [];
        for (const candidate of candidates) {
            const item = makeCandidateItem(candidate, currentFilePath, replaceRange, options);
            if (item) items.push(item);
        }
        cache.set(cacheKey, items);
        return items;
    }

    function getExistingArgumentBlockCacheKey(block = null) {
        if (!block?.open) return '';
        const close = block.close || {};
        return [
            block.open.line,
            block.open.character,
            Number.isInteger(close.line) ? close.line : -1,
            Number.isInteger(close.character) ? close.character : -1
        ].join(':');
    }

    function getForwardBodyReplacementRange(replaceRange = null, existingArgumentBlock = null) {
        const close = existingArgumentBlock?.close;
        if (!replaceRange?.start || !Number.isInteger(close?.line) || !Number.isInteger(close?.character)) {
            return replaceRange;
        }
        return new vscode.Range(
            replaceRange.start,
            new vscode.Position(close.line, close.character + 1)
        );
    }

    function addForwardImplementationAlias(map, alias, data) {
        const key = String(alias || '').toLowerCase();
        if (!key || map.has(key)) return;
        map.set(key, data);
    }

    function getForwardImplementationDeclMap(incDecls) {
        if (!Array.isArray(incDecls) || !incDecls.length) return new Map();
        const cached = forwardImplementationDeclMapCache.get(incDecls);
        if (cached) return cached;

        const map = new Map();
        for (const data of incDecls) {
            if (!data || data.type !== 'forward' || !isFunctionLikeDecl(data)) continue;
            const identity = getCompletionIdentity(data);
            addForwardImplementationAlias(map, identity.name, data);
            addForwardImplementationAlias(map, identity.callInsertName, data);
        }
        forwardImplementationDeclMapCache.set(incDecls, map);
        return map;
    }

    function findForwardImplementationDecl(data, incDecls) {
        if (!data || data.type === 'forward') return null;
        const map = getForwardImplementationDeclMap(incDecls);
        if (!map.size) return null;
        const identity = getCompletionIdentity(data);
        const aliases = identity.normalizedFilterAliases?.length
            ? identity.normalizedFilterAliases
            : [identity.normalizedFilterText];
        for (const alias of aliases) {
            const forwardDecl = map.get(String(alias || '').toLowerCase());
            if (forwardDecl) return forwardDecl;
        }
        return null;
    }

    function getForwardImplementationCandidates(candidates, incDecls) {
        if (!Array.isArray(candidates) || !candidates.length || !Array.isArray(incDecls) || !incDecls.length) {
            return candidates;
        }

        let perIncludeCache = forwardImplementationCandidatesCache.get(candidates);
        if (!perIncludeCache) {
            perIncludeCache = new WeakMap();
            forwardImplementationCandidatesCache.set(candidates, perIncludeCache);
        }
        const cached = perIncludeCache.get(incDecls);
        if (cached) return cached;

        const result = [];
        const seen = new Set();
        for (const candidate of candidates) {
            const forwardDecl = findForwardImplementationDecl(candidate?.d, incDecls);
            const resolvedCandidate = forwardDecl
                ? { d: forwardDecl, p: candidate.p, i: getCompletionIdentity(forwardDecl) }
                : candidate;
            const data = resolvedCandidate?.d;
            const identity = resolvedCandidate?.i || getCompletionIdentity(data);
            const key = [
                data?.type || '',
                identity?.name || data?.name || '',
                data?.filePath || ''
            ].join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(resolvedCandidate);
        }
        perIncludeCache.set(incDecls, result);
        return result;
    }

    function filterCompletionCandidatesForIntent(candidates, completionIntent) {
        if (!Array.isArray(candidates) || !candidates.length) return [];
        if (completionIntent === 'variable-declaration') return [];
        if (completionIntent === 'top-level-declaration') {
            return candidates.filter(candidate =>
                candidate?.d?.type === 'forward' &&
                isFunctionLikeDecl(candidate.d)
            );
        }
        if (completionIntent === 'call') {
            return candidates.filter(candidate => candidate?.d?.type !== 'forward');
        }
        return candidates;
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
        if (!previous || String(sortPrefix) < String(previous.p)) {
            map.set(decl.name, { d: decl, p: sortPrefix, i: getCompletionIdentity(decl) });
        }
    }

    function getBaseCompletionCandidates(ctx, line) {
        if (!ctx || typeof ctx !== 'object') return [];
        let perLineCache = baseCandidatesCache.get(ctx);
        if (!perLineCache) {
            perLineCache = new Map();
            baseCandidatesCache.set(ctx, perLineCache);
        }
        const cacheKey = Number.isInteger(line) ? line : -1;
        const cached = perLineCache.get(cacheKey);
        if (cached) return cached;

        const { parsedDecls, incDecls, lookup } = ctx;
        const { globals, functions, locals, funcArgs } = parsedDecls;
        const candidates = [];
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
        varMap.forEach(({ d, p }) => candidates.push({ d, p }));

        functions.forEach(d => candidates.push({ d, p: '010', i: getCompletionIdentity(d) }));
        for (const d of incDecls) {
            if (d.type !== 'variable' && d.type !== 'enum-item' && d.type !== 'enum' && d.type !== 'define') {
                if (isFunctionLikeDecl(d)) {
                    const preferredIncludeFunc = lookup?.getPreferredFunctionMatch?.(d.name)?.data || null;
                    if (d.type !== 'forward' && preferredIncludeFunc && preferredIncludeFunc !== d) continue;
                }
                candidates.push({ d, p: '011', i: getCompletionIdentity(d) });
            }
        }
        perLineCache.set(cacheKey, candidates);
        return candidates;
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

    function getCompletionDataFilterAliases(data) {
        return getCompletionIdentity(data).normalizedFilterAliases || [getCompletionDataFilterText(data)];
    }

    function partitionByPrefix(entries, prefix, getText) {
        const normalizedPrefix = String(prefix || '').toLowerCase();
        if (!normalizedPrefix) {
            return {
                entries,
                startsWithCount: entries.length,
                containsCount: entries.length,
                mode: 'all'
            };
        }
        const startsWith = [];
        const contains = [];
        for (const entry of entries) {
            const text = getText(entry);
            if (!text) continue;
            if (text.startsWith(normalizedPrefix)) {
                startsWith.push(entry);
            } else if (text.includes(normalizedPrefix)) {
                contains.push(entry);
            }
        }
        if (startsWith.length) {
            return {
                entries: startsWith,
                startsWithCount: startsWith.length,
                containsCount: startsWith.length + contains.length,
                mode: 'startsWith'
            };
        }
        return {
            entries: contains,
            startsWithCount: 0,
            containsCount: contains.length,
            mode: 'contains'
        };
    }

    function filterCompletionItemsForPrefix(items, prefix) {
        const result = partitionByPrefix(items, prefix, getCompletionItemFilterText);
        return { ...result, items: result.entries };
    }

    function filterCompletionCandidatesForPrefix(candidates, prefix) {
        const normalizedPrefix = String(prefix || '').toLowerCase();
        if (Array.isArray(candidates)) {
            let prefixCache = candidatePrefixFilterCache.get(candidates);
            if (!prefixCache) {
                prefixCache = new Map();
                candidatePrefixFilterCache.set(candidates, prefixCache);
            }
            if (prefixCache.has(normalizedPrefix)) return prefixCache.get(normalizedPrefix);
            if (prefixCache.size > 24) prefixCache.clear();
            const result = filterCompletionCandidatesForPrefixUncached(candidates, normalizedPrefix);
            prefixCache.set(normalizedPrefix, result);
            return result;
        }
        return filterCompletionCandidatesForPrefixUncached(candidates, normalizedPrefix);
    }

    function filterCompletionCandidatesForPrefixUncached(candidates, normalizedPrefix) {
        if (!normalizedPrefix) {
            return {
                entries: candidates,
                candidates,
                startsWithCount: candidates.length,
                containsCount: candidates.length,
                mode: 'all'
            };
        }

        const startsWith = [];
        const contains = [];
        for (const candidate of candidates) {
            const aliases = candidate.i?.normalizedFilterAliases || getCompletionDataFilterAliases(candidate.d);
            let matchedContains = false;
            let matchedStartsWith = false;
            for (const alias of aliases) {
                if (!alias) continue;
                if (alias.startsWith(normalizedPrefix)) {
                    matchedStartsWith = true;
                    break;
                }
                if (!matchedContains && alias.includes(normalizedPrefix)) {
                    matchedContains = true;
                }
            }
            if (matchedStartsWith) {
                startsWith.push(candidate);
            } else if (matchedContains) {
                contains.push(candidate);
            }
        }
        const result = startsWith.length
            ? {
                entries: startsWith,
                startsWithCount: startsWith.length,
                containsCount: startsWith.length + contains.length,
                mode: 'startsWith'
            }
            : {
                entries: contains,
                startsWithCount: 0,
                containsCount: contains.length,
                mode: 'contains'
            };
        return { ...result, candidates: result.entries };
    }

    function getCompletionStartCharacter(position, replaceRange) {
        return Number.isInteger(replaceRange?.start?.character)
            ? replaceRange.start.character
            : (Number.isInteger(position?.character) ? position.character : 0);
    }

    function getLineTextBeforeCompletion(document, position, replaceRange) {
        const lineNumber = Number.isInteger(position?.line) ? position.line : -1;
        if (lineNumber < 0) return '';
        const lineText = String(document?.lineAt?.(lineNumber)?.text || '');
        return lineText.slice(0, Math.max(0, getCompletionStartCharacter(position, replaceRange)));
    }

    function isStatementStartCompletionContext(document, position, replaceRange) {
        const before = getLineTextBeforeCompletion(document, position, replaceRange).trim();
        if (!before) return true;
        return /^(?:\}|\}\s*else)\s*$/.test(before);
    }

    function isElseCompletionContext(document, position, replaceRange) {
        const before = getLineTextBeforeCompletion(document, position, replaceRange).trim();
        return !before || before === '}';
    }

    function makeServiceKeywordItem(definition, sortIndex, replaceRange = null) {
        const item = new vscode.CompletionItem(definition.name);
        item.kind = vscode.CompletionItemKind.Keyword;
        item.filterText = definition.name;
        item.sortText = `000_${String(sortIndex).padStart(3, '0')}_${definition.name}`;
        item.detail = definition.detail;
        item.label = { label: definition.name, description: definition.detail };
        item.labelDetails = { description: definition.detail };
        item.insertText = new vscode.SnippetString(definition.insertText);
        if (replaceRange) item.range = replaceRange;
        return item;
    }

    function getServiceKeywordCandidatesForPrefix(prefix, hasExistingStartsWith = false) {
        const normalizedPrefix = String(prefix || '').toLowerCase();
        if (!normalizedPrefix) {
            return SERVICE_KEYWORD_COMPLETIONS.map((definition, index) => ({ definition, index }));
        }

        const startsWith = [];
        const contains = [];
        SERVICE_KEYWORD_COMPLETIONS.forEach((definition, index) => {
            const name = String(definition.name || '').toLowerCase();
            if (name.startsWith(normalizedPrefix)) {
                startsWith.push({ definition, index });
            } else if (name.includes(normalizedPrefix)) {
                contains.push({ definition, index });
            }
        });
        if (hasExistingStartsWith || startsWith.length) return startsWith;
        return contains;
    }

    function getCompletionPositionCacheKey(document, position, replaceRange = null) {
        const line = Number.isInteger(position?.line) ? position.line : -1;
        const character = Number.isInteger(position?.character) ? position.character : -1;
        const rangeStart = Number.isInteger(replaceRange?.start?.character)
            ? replaceRange.start.character
            : character;
        const version = document?.version ?? '';
        return `${version}:${line}:${character}:${rangeStart}`;
    }

    function getCachedCompletionPositionValue(cacheRoot, document, position, replaceRange, createValue) {
        if (!document || typeof document !== 'object') {
            return createValue();
        }
        let cache = cacheRoot.get(document);
        if (!cache) {
            cache = new Map();
            cacheRoot.set(document, cache);
        }
        const key = getCompletionPositionCacheKey(document, position, replaceRange);
        if (cache.has(key)) return cache.get(key);
        const result = createValue();
        cache.set(key, result);
        return result;
    }

    function getCachedCompletionControlContext(options) {
        return getCachedCompletionPositionValue(
            controlContextCache,
            options?.document,
            options?.position,
            options?.replaceRange,
            () => getCompletionControlContext(options)
        );
    }

    function getCachedCompletionIntent(document, position, ctx, replaceRange = null) {
        return getCachedCompletionPositionValue(
            completionIntentCache,
            document,
            position,
            replaceRange,
            () => getCompletionIntent(document, position, ctx)
        );
    }

    function addServiceKeywordCompletions(items, document, position, replaceRange, ctx, prefix = '', hasExistingStartsWith = false) {
        const candidates = getServiceKeywordCandidatesForPrefix(prefix, hasExistingStartsWith);
        if (!candidates.length) return;
        const statementContext = isStatementStartCompletionContext(document, position, replaceRange);
        const elseContext = isElseCompletionContext(document, position, replaceRange);
        let controlContext = null;
        const ensureControlContext = () => {
            if (controlContext) return controlContext;
            controlContext = getCachedCompletionControlContext({
                document,
                position,
                replaceRange,
                ctx,
                classifyPawnStatementLine,
                countStructuralBraces,
                findFirstNonWhitespaceIndex,
                findKeywordOccurrences,
                skipInlineControlHeader
            });
            return controlContext;
        };

        candidates.forEach(({ definition, index }) => {
            let allowed = false;
            switch (definition.context) {
                case 'statement':
                    allowed = statementContext;
                    break;
                case 'else':
                    allowed = elseContext;
                    break;
                case 'loop':
                    allowed = statementContext && ensureControlContext().inLoop;
                    break;
                case 'break':
                    allowed = statementContext && (
                        ensureControlContext().inLoop ||
                        ensureControlContext().inSwitch
                    );
                    break;
                case 'switch-label':
                    allowed = statementContext && ensureControlContext().inDirectSwitchBody;
                    break;
                default:
                    allowed = false;
            }
            if (allowed) {
                items.push(makeServiceKeywordItem(definition, index, replaceRange));
            }
        });
    }

    function wrapCompletionSignature(signature) {
        const source = String(signature || '');
        if (source.length <= COMPLETION_SIGNATURE_WRAP_WIDTH) return source;
        const openIndex = source.indexOf('(');
        const closeIndex = source.lastIndexOf(')');
        if (openIndex < 0 || closeIndex <= openIndex) return source;

        const prefix = source.slice(0, openIndex + 1);
        const argsText = source.slice(openIndex + 1, closeIndex);
        const suffix = source.slice(closeIndex);
        const args = splitTopLevel(argsText);
        if (!args.length) return source;

        return [
            prefix,
            ...args.map((arg, index) => `    ${String(arg || '').trim()}${index + 1 < args.length ? ',' : ''}`),
            suffix
        ].join('\n');
    }

    function wrapMarkdownLine(line, firstPrefix = '', nextPrefix = firstPrefix, width = COMPLETION_DOC_WRAP_WIDTH) {
        const words = String(line || '').trim().split(/\s+/).filter(Boolean);
        if (!words.length) return firstPrefix.trimEnd();

        const lines = [];
        let current = firstPrefix;
        let currentWidth = firstPrefix.length;
        let hasWord = false;
        for (const word of words) {
            const spacer = hasWord ? ' ' : '';
            if (currentWidth + spacer.length + word.length > width && current.trim()) {
                lines.push(current.trimEnd());
                current = nextPrefix + word;
                currentWidth = nextPrefix.length + word.length;
                hasWord = true;
            } else {
                current += spacer + word;
                currentWidth += spacer.length + word.length;
                hasWord = true;
            }
        }
        if (current.trim()) lines.push(current.trimEnd());
        return lines.join('\n');
    }

    function formatCompletionDocsText(docsText) {
        const source = String(docsText || '').replace(/\r\n?/g, '\n').trim();
        if (!source) return '';

        const result = [];
        let inFence = false;
        for (const rawLine of source.split('\n')) {
            const line = rawLine.trim();
            if (!line) {
                result.push('');
                continue;
            }
            if (line.startsWith('```')) {
                inFence = !inFence;
                result.push(rawLine);
                continue;
            }
            if (inFence) {
                result.push(rawLine);
                continue;
            }

            const paramMatch = line.match(/^@(param)\s+(\S+)\s*(.*)$/i);
            if (paramMatch) {
                result.push(wrapMarkdownLine(
                    paramMatch[3] || '',
                    `- **@${paramMatch[1]} \`${paramMatch[2]}\`** `,
                    '  '
                ));
                continue;
            }

            const tagMatch = line.match(/^@(return|returns|note|error|deprecated|warning|warn|throws?)\s*(.*)$/i);
            if (tagMatch) {
                result.push(wrapMarkdownLine(
                    tagMatch[2] || '',
                    `- **@${tagMatch[1]}** `,
                    '  '
                ));
                continue;
            }

            result.push(wrapMarkdownLine(line));
        }
        return result.join('\n');
    }

    const completionProvider = {
        provideCompletionItems(document, position) {
            const startedAt = Date.now();
            try {
                const fileName = String(document?.fileName || '');
                const line = Number.isInteger(position?.line) ? position.line : -1;
                const character = Number.isInteger(position?.character) ? position.character : -1;
                logCompletion(`start file=${fileName} pos=${line}:${character} version=${document?.version ?? ''}`);
                if (!isCompletionEnabled()) {
                    logCompletion(`skip disabled file=${fileName} ms=${Date.now() - startedAt}`);
                    return [];
                }
                const contextStartedAt = Date.now();
                const ctx = getPawnDocumentContext(document, position.line);
                const contextMs = Date.now() - contextStartedAt;
                if (!ctx) {
                    logCompletion(
                        `no-context file=${fileName} pos=${line}:${character} lang=${document?.languageId || ''} ` +
                        `contextMs=${contextMs} ms=${Date.now() - startedAt}`
                    );
                    return [];
                }
                const replaceRange = getCompletionReplaceRange(document, position);
                const prefix = replaceRange ? document.getText(replaceRange) : '';
                const { fp, parsedDecls, incDecls, lookup } = ctx;
                const { globals, functions, locals, funcArgs } = parsedDecls;
                const forwardBodyStyle = normalizeForwardCompletionBodyStyle(getForwardCompletionBodyStyle());
                const completionIntent = getCachedCompletionIntent(document, position, ctx, replaceRange);
                const insertionContext = completionInsertTextCore.getFunctionCompletionInsertionContext(
                    document,
                    position,
                    replaceRange,
                    {
                        escapeChar: ctx.lineCtrlChars?.[line] || ''
                    }
                );
                const completionItemOptions = {
                    forwardBodyStyle,
                    isForwardImplementationContext: forwardBodyStyle !== 'disabled' &&
                        completionIntent === 'top-level-declaration',
                    callInsertMode: insertionContext.shouldInsertCallArguments ? 'call-with-args' : 'name-only',
                    existingArgumentBlock: insertionContext.existingArgumentBlock,
                    prefixStartsWithAt: String(prefix || '').trimStart().startsWith('@')
                };

                const candidates = getBaseCompletionCandidates(ctx, line);
                const intentCandidates = filterCompletionCandidatesForIntent(candidates, completionIntent);
                const filteredCandidates = filterCompletionCandidatesForPrefix(intentCandidates, prefix);
                const completionCandidates = completionItemOptions.isForwardImplementationContext
                    ? getForwardImplementationCandidates(filteredCandidates.candidates, incDecls)
                    : filteredCandidates.candidates;
                const items = getCandidateCompletionItems(
                    completionCandidates,
                    fp,
                    replaceRange,
                    completionItemOptions
                ).slice();
                if (completionIntent === 'call') {
                    addServiceKeywordCompletions(
                        items,
                        document,
                        position,
                        replaceRange,
                        ctx,
                        prefix,
                        filteredCandidates.startsWithCount > 0
                    );
                }

                logCompletion(
                    `items=${items.length}/${items.length} candidates=${filteredCandidates.candidates.length}/${intentCandidates.length}/${candidates.length} ` +
                    `prefix="${prefix}" mode=${filteredCandidates.mode} candidateMode=${filteredCandidates.mode} ` +
                    `startsWith=${filteredCandidates.startsWithCount} contains=${filteredCandidates.containsCount} ` +
                    `file=${fileName} pos=${line}:${character} ` +
                    `callInsert=${completionItemOptions.callInsertMode} ` +
                    `globals=${globals.length} locals=${locals.length} args=${funcArgs.length} ` +
                    `functions=${functions.length} includes=${incDecls.length} ` +
                    `intent=${completionIntent} contextMs=${contextMs} ms=${Date.now() - startedAt}`
                );
                return typeof vscode.CompletionList === 'function'
                    ? new vscode.CompletionList(items, !!prefix)
                    : items;
            } catch (error) {
                logCompletion(`error ${error?.stack || String(error)}`);
                console.error('AMXX Pawn completion provider failed:', error);
                return [];
            }
        },

        resolveCompletionItem(item) {
            const startedAt = Date.now();
            try {
                if (!isCompletionEnabled()) {
                    logCompletion(`resolve-skip disabled ms=${Date.now() - startedAt}`);
                    return item;
                }
                const data = item._pawnData;
                if (!data) {
                    logCompletion(`resolve-skip no-data label=${String(item?.label?.label || item?.label || '')} ms=${Date.now() - startedAt}`);
                    return item;
                }
                logCompletion(
                    `resolve-start name=${String(data.name || '')} type=${String(data.type || '')} ` +
                    `file=${String(data.filePath || '')}`
                );
                const currentFilePath = item._pawnCurrentFilePath || '';
                const md = new vscode.MarkdownString();
                md.isTrusted = true;
                md.supportHtml = true;
                const signature = buildSig(data);
                if (signature) {
                    md.appendCodeblock(wrapCompletionSignature(signature), 'amxxpawn');
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
                if (docsText) md.appendMarkdown(`\n\n### ${t('hover.description')}\n${formatCompletionDocsText(docsText)}`);
                item.documentation = md;
                logCompletion(
                    `resolve-done name=${String(data.name || '')} type=${String(data.type || '')} ` +
                    `docs=${docsText ? 1 : 0} ms=${Date.now() - startedAt}`
                );
            } catch (error) {
                logCompletion(`resolve-error ms=${Date.now() - startedAt} ${error?.stack || String(error)}`);
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
