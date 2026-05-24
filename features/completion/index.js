const {
    getCompletionControlContext,
    getCompletionIntent
} = require('../../core/syntax/control-context');
const { PAWN_IDENTIFIER_RE } = require('../../core/syntax/identifiers');
const {
    PREPROCESSOR_DIRECTIVE_COMPLETIONS,
    PRAGMA_DIRECTIVE_COMPLETIONS,
    getPreprocessorDirectiveCompletionContext
} = require('../../core/syntax/preprocessor-directives');
const { getPawnIncludeCompletionContext } = require('../../core/syntax/includes');
const {
    createCompletionInsertTextCore
} = require('../../core/completion/insert-text');
const {
    getBestCompletionMatch,
    withCompletionMatchSortPrefix
} = require('../../core/completion/matching');
const {
    compareCompletionCandidatePriority,
    dedupeCompletionCandidates: dedupeCompletionCandidateList
} = require('../../core/completion/candidates');
const {
    COMPLETION_TRIGGER_CHARACTERS,
    INCLUDE_COMPLETION_TRIGGER_CHARACTERS
} = require('../../core/completion/triggers');
const {
    createServiceKeywordCandidateSelector
} = require('../../core/completion/service-keywords');
const {
    normalizeCompletionCallArgumentMode
} = require('../../core/completion/call-argument-mode');
const { isNumericObjectLikeDefineDecl } = require('../../core/syntax/numeric-defines');
const { createPrefixedDebugLogger } = require('../../core/utils/debug-logger');

const ARRAY_DIMENSION_BUILTIN_NAMES = new Set(['sizeof', 'charsmax']);
const PAWN_COMPLETION_WORD_RE = PAWN_IDENTIFIER_RE;
const COMPLETION_SIGNATURE_WRAP_WIDTH = 96;
const COMPLETION_DOC_WRAP_WIDTH = 88;

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
        getIncludeCompletionEntries = () => [],
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
        getCompletionCallArgumentMode = () => 'required-before-default',
        getCompletionAutoHideDelayMs = () => 0,
        completionOutputChannel = null
    } = deps;

    const logCompletion = createPrefixedDebugLogger(completionOutputChannel, 'completion');
    const declarationArgSnippetTextCache = new WeakMap();
    const callArgSnippetTextCache = new WeakMap();
    const detailLabelCache = new WeakMap();
    const completionIdentityCache = new WeakMap();
    const baseCandidatesCache = new WeakMap();
    const intentCandidatesCache = new WeakMap();
    const dedupedCandidatesCache = new WeakMap();
    const candidatePrefixFilterCache = new WeakMap();
    const candidateItemsCache = new WeakMap();
    const mergedCompletionItemsCache = new WeakMap();
    const forwardImplementationDeclMapCache = new WeakMap();
    const forwardImplementationCandidatesCache = new WeakMap();
    const controlContextCache = new WeakMap();
    const completionIntentCache = new WeakMap();
    const includeDeclSourceMetaCache = new WeakMap();
    const serviceKeywordItemsCache = new WeakMap();
    const getServiceKeywordCandidatesForPrefix = createServiceKeywordCandidateSelector();
    const MAX_CANDIDATE_ITEM_CACHE_ENTRIES = 16;
    const completionInsertTextCore = createCompletionInsertTextCore({
        splitTopLevel,
        parseParamMeta,
        isEscapedQuote
    });
    let completionAutoHideTimer = null;

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

    function getCallArgSnippetText(data, callArgumentMode = 'required-before-default') {
        if (!data || typeof data !== 'object') return '';
        const normalizedCallArgumentMode = normalizeCompletionCallArgumentMode(callArgumentMode);
        let perModeCache = callArgSnippetTextCache.get(data);
        if (!perModeCache) {
            perModeCache = new Map();
            callArgSnippetTextCache.set(data, perModeCache);
        }
        if (perModeCache.has(normalizedCallArgumentMode)) return perModeCache.get(normalizedCallArgumentMode);
        const snippetText = completionInsertTextCore.buildCallArgSnippetText(data.args || '', {
            callArgumentMode: normalizedCallArgumentMode
        });
        perModeCache.set(normalizedCallArgumentMode, snippetText);
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

    function clearCompletionAutoHideTimer() {
        if (!completionAutoHideTimer) return;
        clearTimeout(completionAutoHideTimer);
        completionAutoHideTimer = null;
    }

    function executeHideCompletionWidget(reason = 'completion-final') {
        if (typeof vscode?.commands?.executeCommand !== 'function') return;
        try {
            const result = vscode.commands.executeCommand('hideSuggestWidget');
            if (result && typeof result.catch === 'function') {
                result.catch(() => {});
            }
            logCompletion(() => `hide-widget reason=${reason}`);
        } catch {
            // Best-effort UI cleanup only; completion results must not fail because of it.
        }
    }

    function hideCompletionWidget(reason = 'completion-final', options = {}) {
        clearCompletionAutoHideTimer();
        executeHideCompletionWidget(reason);
        if (!options.defer) return;
        completionAutoHideTimer = setTimeout(() => {
            completionAutoHideTimer = null;
            executeHideCompletionWidget(`${reason}-deferred`);
        }, 0);
    }

    function normalizeCompletionAutoHideDelayMs(value) {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0) return 0;
        return Math.min(10000, Math.floor(number));
    }

    function scheduleCompletionAutoHide() {
        clearCompletionAutoHideTimer();
        const delayMs = normalizeCompletionAutoHideDelayMs(getCompletionAutoHideDelayMs());
        if (delayMs <= 0 || typeof vscode?.commands?.executeCommand !== 'function') return;
        completionAutoHideTimer = setTimeout(() => {
            completionAutoHideTimer = null;
            hideCompletionWidget('idle-timeout');
        }, delayMs);
    }

    function makeCompletionList(items, isIncomplete = false) {
        return typeof vscode.CompletionList === 'function'
            ? new vscode.CompletionList(items, isIncomplete)
            : items;
    }

    function getCompletionItemLabelText(item) {
        if (!item) return '';
        if (typeof item.label === 'string') return item.label;
        return String(item.label?.label || '');
    }

    function getCompletionItemInsertTextText(item) {
        const insertText = item?.insertText;
        if (typeof insertText === 'string') return insertText;
        if (insertText && typeof insertText.value === 'string') return insertText.value;
        return '';
    }

    function getAlreadyTypedCompletionTexts(item) {
        const values = [
            getCompletionItemLabelText(item),
            item?.filterText,
            getCompletionItemInsertTextText(item)
        ];
        const data = item?._pawnData;
        if (data && typeof data === 'object') {
            const identity = getCompletionIdentity(data);
            values.push(
                identity.name,
                identity.callInsertName,
                identity.filterText,
                ...(identity.filterAliases || [])
            );
        }
        return values
            .map(value => String(value || '').trim())
            .filter(Boolean);
    }

    function isCompletionItemAlreadyTyped(item, prefix = '') {
        const typed = String(prefix || '').trim();
        if (!typed) return false;
        const insertText = getCompletionItemInsertTextText(item).trim();
        if (insertText) {
            return insertText === typed;
        }
        return getAlreadyTypedCompletionTexts(item).some(value => value === typed);
    }

    function shouldHideFinalCompletionResult(items, prefix = '') {
        if (!Array.isArray(items) || items.length <= 0) return 'empty';
        if (items.length === 1 && isCompletionItemAlreadyTyped(items[0], prefix)) {
            return 'single-exact';
        }
        return '';
    }

    function finalizeCompletionResult(items, prefix = '', options = {}) {
        const normalizedItems = Array.isArray(items) ? items : [];
        const hideReason = shouldHideFinalCompletionResult(normalizedItems, prefix);
        if (hideReason) {
            hideCompletionWidget(hideReason, { defer: true });
            return makeCompletionList([], false);
        }
        scheduleCompletionAutoHide();
        return makeCompletionList(normalizedItems, !!options.isIncomplete);
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
                const argSnippetText = getCallArgSnippetText(data, options.callArgumentMode);
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
            String(options.callArgumentMode || ''),
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
                ? { ...candidate, d: forwardDecl, i: getCompletionIdentity(forwardDecl) }
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

    function dedupeCompletionCandidates(candidates) {
        if (!Array.isArray(candidates) || candidates.length <= 1) return candidates;
        const cached = dedupedCandidatesCache.get(candidates);
        if (cached) return cached;

        const deduped = dedupeCompletionCandidateList(candidates);
        dedupedCandidatesCache.set(candidates, deduped);
        return deduped;
    }

    function isFunctionLikeDefineCompletionCandidate(candidate) {
        return candidate?.d?.type === 'define' &&
            isFunctionLikeDefineDecl(candidate.d);
    }

    function isArrayDimensionBuiltinDecl(decl) {
        return ARRAY_DIMENSION_BUILTIN_NAMES.has(String(decl?.name || '')) &&
            (
                decl?.type === 'builtin' ||
                isFunctionLikeDecl(decl) ||
                isFunctionLikeDefineDecl(decl)
            );
    }

    function isArrayDimensionCompletionDecl(decl) {
        if (!decl?.name) return false;
        if (isArrayDimensionBuiltinDecl(decl)) return true;
        if (decl.type === 'enum' || decl.type === 'enum-item') return true;
        return isNumericObjectLikeDefineDecl(decl);
    }

    function filterCompletionCandidatesForIntentUncached(candidates, completionIntent) {
        if (!Array.isArray(candidates) || !candidates.length) return [];
        let filtered = null;
        if (completionIntent === 'array-dimension') {
            filtered = [];
            for (const candidate of candidates) {
                if (isArrayDimensionCompletionDecl(candidate?.d)) filtered.push(candidate);
            }
            return filtered;
        }
        if (completionIntent === 'variable-declaration') {
            filtered = [];
            for (const candidate of candidates) {
                if (isFunctionLikeDefineCompletionCandidate(candidate)) filtered.push(candidate);
            }
            return filtered;
        }
        if (completionIntent === 'top-level-declaration') {
            filtered = [];
            for (const candidate of candidates) {
                if (
                    candidate?.d?.type === 'forward' &&
                    isFunctionLikeDecl(candidate.d)
                ) {
                    filtered.push(candidate);
                    continue;
                }
                if (isFunctionLikeDefineCompletionCandidate(candidate)) filtered.push(candidate);
            }
            return filtered;
        }
        if (completionIntent === 'call') {
            filtered = [];
            for (const candidate of candidates) {
                if (candidate?.d?.type !== 'forward') filtered.push(candidate);
            }
            return filtered;
        }
        return candidates;
    }

    function filterCompletionCandidatesForIntent(candidates, completionIntent) {
        if (!Array.isArray(candidates) || !candidates.length) return [];
        let perIntentCache = intentCandidatesCache.get(candidates);
        if (!perIntentCache) {
            perIntentCache = new Map();
            intentCandidatesCache.set(candidates, perIntentCache);
        }
        const key = String(completionIntent || '');
        if (perIntentCache.has(key)) return perIntentCache.get(key);
        const filtered = filterCompletionCandidatesForIntentUncached(candidates, completionIntent);
        perIntentCache.set(key, filtered);
        return filtered;
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

    function makeCompletionCandidate(decl, sortPrefix, sourceMeta = null) {
        const candidate = {
            d: decl,
            p: `${sortPrefix}_${decl?.deprecated === true ? '9deprecated' : '0active'}`,
            i: getCompletionIdentity(decl)
        };
        if (sourceMeta && Number.isFinite(sourceMeta.sourcePriority)) {
            candidate.sourcePriority = sourceMeta.sourcePriority;
            candidate.sourcePath = sourceMeta.sourcePath || '';
            candidate.resolutionKind = sourceMeta.resolutionKind || '';
        }
        return candidate;
    }

    function getIncludeDeclSourceMeta(ctx, decl) {
        if (typeof ctx?.getIncludeSourceMetaForPath !== 'function') return null;
        const filePath = String(decl?.filePath || '');
        if (!filePath) return null;
        let cache = includeDeclSourceMetaCache.get(ctx);
        if (!cache) {
            cache = new Map();
            includeDeclSourceMetaCache.set(ctx, cache);
        }
        if (cache.has(filePath)) return cache.get(filePath);
        const meta = ctx.getIncludeSourceMetaForPath(filePath) || null;
        cache.set(filePath, meta);
        return meta;
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

    function setBestCompletionCandidate(map, decl, sortPrefix, sourceMeta = null) {
        if (!decl?.name) return;
        const candidate = makeCompletionCandidate(decl, sortPrefix, sourceMeta);
        const previous = map.get(decl.name);
        if (!previous || compareCompletionCandidatePriority(candidate, 0, previous, 1) < 0) {
            map.set(decl.name, candidate);
        }
    }

    function collectFunctionLikeDefineCompletionCandidates(target, decls, sortPrefix, getSourceMeta = null) {
        for (const d of decls || []) {
            if (d?.type !== 'define' || !isFunctionLikeDefineDecl(d)) continue;
            target.push(makeCompletionCandidate(d, sortPrefix, getSourceMeta?.(d) || null));
        }
    }

    function getFunctionLikeDefineCompletionCandidates(ctx) {
        const { parsedDecls, incDecls } = ctx;
        const candidates = [];
        collectFunctionLikeDefineCompletionCandidates(candidates, BUILTIN_DECLS, '006');
        collectFunctionLikeDefineCompletionCandidates(
            candidates,
            incDecls,
            '005',
            decl => getIncludeDeclSourceMeta(ctx, decl)
        );
        collectFunctionLikeDefineCompletionCandidates(candidates, parsedDecls?.globals || [], '004');
        collectFunctionLikeDefineCompletionCandidates(candidates, parsedDecls?.functions || [], '010');
        return candidates;
    }

    function collectArrayDimensionCompletionCandidates(target, decls, sortPrefix, getSourceMeta = null) {
        for (const decl of decls || []) {
            if (!isArrayDimensionCompletionDecl(decl)) continue;
            target.push(makeCompletionCandidate(decl, sortPrefix, getSourceMeta?.(decl) || null));
        }
    }

    function hasCompletionCandidateNamed(candidates, name) {
        const target = String(name || '');
        return !!target && candidates.some(candidate => candidate?.d?.name === target);
    }

    function getArrayDimensionCompletionCandidates(ctx) {
        const { parsedDecls, incDecls } = ctx;
        const candidates = [];
        collectArrayDimensionCompletionCandidates(candidates, BUILTIN_DECLS, '006');
        collectArrayDimensionCompletionCandidates(
            candidates,
            incDecls,
            '005',
            decl => getIncludeDeclSourceMeta(ctx, decl)
        );
        collectArrayDimensionCompletionCandidates(candidates, parsedDecls?.globals || [], '004');
        collectArrayDimensionCompletionCandidates(candidates, parsedDecls?.locals || [], '002');

        if (!hasCompletionCandidateNamed(candidates, 'charsmax')) {
            candidates.push(makeCompletionCandidate({
                name: 'charsmax',
                type: 'builtin',
                args: 'symbol',
                docs: 'Compile-time array max index helper.'
            }, '006'));
        }

        return candidates;
    }

    function getTopLevelDeclarationCompletionCandidates(ctx) {
        const { parsedDecls, incDecls } = ctx;
        const candidates = getFunctionLikeDefineCompletionCandidates(ctx).slice();
        for (const d of parsedDecls?.functions || []) {
            if (d?.type === 'forward' && isFunctionLikeDecl(d)) {
                candidates.push(makeCompletionCandidate(d, '010'));
            }
        }
        for (const d of incDecls || []) {
            if (d?.type === 'forward' && isFunctionLikeDecl(d)) {
                candidates.push(makeCompletionCandidate(d, '011', getIncludeDeclSourceMeta(ctx, d)));
            }
        }
        return candidates;
    }

    function getBaseCompletionCandidates(ctx, line, completionIntent = '') {
        if (!ctx || typeof ctx !== 'object') return [];
        let perLineCache = baseCandidatesCache.get(ctx);
        if (!perLineCache) {
            perLineCache = new Map();
            baseCandidatesCache.set(ctx, perLineCache);
        }
        const cacheKey = `${Number.isInteger(line) ? line : -1}:${completionIntent || ''}`;
        const cached = perLineCache.get(cacheKey);
        if (cached) return cached;

        const { parsedDecls, incDecls } = ctx;
        const { globals, functions, locals, funcArgs } = parsedDecls;
        if (completionIntent === 'top-level-declaration') {
            const topLevelCandidates = getTopLevelDeclarationCompletionCandidates(ctx);
            perLineCache.set(cacheKey, topLevelCandidates);
            return topLevelCandidates;
        }
        if (completionIntent === 'variable-declaration') {
            const macroDeclarationCandidates = getFunctionLikeDefineCompletionCandidates(ctx);
            perLineCache.set(cacheKey, macroDeclarationCandidates);
            return macroDeclarationCandidates;
        }
        if (completionIntent === 'array-dimension') {
            const arrayDimensionCandidates = getArrayDimensionCompletionCandidates(ctx);
            perLineCache.set(cacheKey, arrayDimensionCandidates);
            return arrayDimensionCandidates;
        }

        const candidates = [];
        const varMap = new Map();
        for (const d of BUILTIN_DECLS) {
            setBestCompletionCandidate(varMap, d, '006');
        }
        for (const d of incDecls) {
            if (d.type === 'variable' || d.type === 'define' || d.type === 'enum-item' || d.type === 'enum') {
                setBestCompletionCandidate(varMap, d, '005', getIncludeDeclSourceMeta(ctx, d));
            }
        }
        for (const d of globals) {
            setBestCompletionCandidate(varMap, d, '004');
        }
        for (const d of locals) {
            setBestCompletionCandidate(varMap, { ...d, isLocal: true }, getScopedLocalSortPrefix(d, line));
        }
        for (const d of funcArgs) {
            setBestCompletionCandidate(varMap, d, '003');
        }
        for (const candidate of varMap.values()) {
            candidates.push(candidate);
        }

        for (const d of functions) {
            candidates.push(makeCompletionCandidate(d, '010'));
        }
        let lookup = null;
        for (const d of incDecls) {
            if (d.type !== 'variable' && d.type !== 'enum-item' && d.type !== 'enum' && d.type !== 'define') {
                if (completionIntent === 'call' && d.type === 'forward') continue;
                if (isFunctionLikeDecl(d)) {
                    if (!lookup) lookup = ctx.lookup;
                    const preferredIncludeFunc = lookup?.getPreferredFunctionMatch?.(d.name)?.data || null;
                    if (d.type !== 'forward' && preferredIncludeFunc && preferredIncludeFunc !== d) continue;
                }
                candidates.push(makeCompletionCandidate(d, '011', getIncludeDeclSourceMeta(ctx, d)));
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

    function getCompletionDataFilterAliases(data) {
        return getCompletionIdentity(data).normalizedFilterAliases || [getCompletionDataFilterText(data)];
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
                fuzzyCount: 0,
                mode: 'all'
            };
        }

        let entries = [];
        let startsWithCount = 0;
        let containsCount = 0;
        let fuzzyCount = 0;
        for (const candidate of candidates) {
            const aliases = candidate.i?.normalizedFilterAliases || getCompletionDataFilterAliases(candidate.d);
            const match = getBestCompletionMatch(aliases, normalizedPrefix, { normalized: true });
            if (!match) continue;
            if (match.kind === 'exact' || match.kind === 'startsWith') {
                startsWithCount++;
            } else if (match.kind === 'contains') {
                containsCount++;
            } else if (match.kind === 'fuzzy') {
                fuzzyCount++;
            }
            const isStartsWithMatch = match.kind === 'exact' || match.kind === 'startsWith';
            if (isStartsWithMatch) {
                if (startsWithCount === 1 && entries.length) entries = [];
                entries.push({
                    ...candidate,
                    p: withCompletionMatchSortPrefix(candidate.p, match)
                });
            } else if (!startsWithCount) {
                entries.push({
                    ...candidate,
                    p: withCompletionMatchSortPrefix(candidate.p, match)
                });
            }
        }
        const result = startsWithCount
            ? {
                entries,
                startsWithCount,
                containsCount: startsWithCount + containsCount,
                fuzzyCount,
                mode: 'startsWith'
            }
            : {
                entries,
                startsWithCount: 0,
                containsCount,
                fuzzyCount,
                mode: containsCount ? 'contains' : 'fuzzy'
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

    function isStatementStartCompletionText(beforeText = '') {
        const before = String(beforeText || '').trim();
        if (!before) return true;
        return /^(?:\}|\}\s*else)\s*$/.test(before);
    }

    function isElseCompletionText(beforeText = '') {
        const before = String(beforeText || '').trim();
        return !before || before === '}';
    }

    function makeServiceKeywordItem(definition, sortIndex, replaceRange = null, match = null) {
        const item = new vscode.CompletionItem(definition.name);
        item.kind = vscode.CompletionItemKind.Keyword;
        item.filterText = definition.name;
        const matchSortKey = match?.sortKey ? `${match.sortKey}_` : '';
        item.sortText = `000_${matchSortKey}${String(sortIndex).padStart(3, '0')}_${definition.name}`;
        item.detail = definition.detail;
        item.label = { label: definition.name, description: definition.detail };
        item.labelDetails = { description: definition.detail };
        item.insertText = new vscode.SnippetString(definition.insertText);
        if (replaceRange) item.range = replaceRange;
        return item;
    }

    function serviceKeywordCandidatesNeedControlContext(candidates) {
        for (const candidate of candidates || []) {
            const context = candidate?.definition?.context || '';
            if (context === 'loop' || context === 'break' || context === 'switch-label') {
                return true;
            }
        }
        return false;
    }

    function isServiceKeywordDefinitionAllowed(definition, state) {
        switch (definition?.context) {
            case 'statement':
                return state.statementContext;
            case 'else':
                return state.elseContext;
            case 'loop':
                return state.statementContext && state.inLoop;
            case 'break':
                return state.statementContext && (state.inLoop || state.inSwitch);
            case 'switch-label':
                return state.statementContext && state.inDirectSwitchBody;
            default:
                return false;
        }
    }

    function getCachedServiceKeywordItems(candidates, replaceRange, state) {
        if (!Array.isArray(candidates) || !candidates.length) return [];
        let cache = serviceKeywordItemsCache.get(candidates);
        if (!cache) {
            cache = new Map();
            serviceKeywordItemsCache.set(candidates, cache);
        }
        const cacheKey = [
            getRangeCacheKey(replaceRange),
            state.statementContext ? 1 : 0,
            state.elseContext ? 1 : 0,
            state.inLoop ? 1 : 0,
            state.inSwitch ? 1 : 0,
            state.inDirectSwitchBody ? 1 : 0
        ].join('|');
        if (cache.has(cacheKey)) return cache.get(cacheKey);
        const items = [];
        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
            const { definition, index, match } = candidates[candidateIndex];
            if (!isServiceKeywordDefinitionAllowed(definition, state)) continue;
            items.push(makeServiceKeywordItem(definition, index, replaceRange, match));
        }
        cache.set(cacheKey, items);
        return items;
    }

    function makeCompletionRange(line, start, end) {
        const startPosition = typeof vscode.Position === 'function'
            ? new vscode.Position(line, start)
            : { line, character: start };
        const endPosition = typeof vscode.Position === 'function'
            ? new vscode.Position(line, end)
            : { line, character: end };
        return new vscode.Range(startPosition, endPosition);
    }

    function makePreprocessorDirectiveItem(definition, sortIndex, replaceRange = null) {
        const item = new vscode.CompletionItem(definition.name);
        item.kind = vscode.CompletionItemKind.Keyword;
        item.filterText = definition.name;
        item.sortText = `000_preprocessor_${String(sortIndex).padStart(3, '0')}_${definition.name}`;
        item.detail = definition.detail;
        item.label = { label: definition.name, description: definition.detail };
        item.labelDetails = { description: definition.detail };
        item.insertText = new vscode.SnippetString(definition.insertText || definition.name);
        if (definition.documentation) {
            const markdown = typeof vscode.MarkdownString === 'function'
                ? new vscode.MarkdownString()
                : null;
            if (markdown?.appendMarkdown) {
                markdown.appendMarkdown(String(definition.documentation || ''));
                item.documentation = markdown;
            } else {
                item.documentation = String(definition.documentation || '');
            }
        }
        if (replaceRange) item.range = replaceRange;
        return item;
    }

    function makeIncludePathCompletionItem(entry, context, sortIndex, replaceRange = null) {
        const name = String(entry?.name || '');
        const item = new vscode.CompletionItem(name);
        item.kind = vscode.CompletionItemKind.File ?? vscode.CompletionItemKind.Text;
        item.filterText = name;
        item.sortText = `000_include_${String(sortIndex).padStart(5, '0')}_${name}`;
        const detail = entry?.sourceKind === 'local'
            ? 'local include'
            : 'include';
        item.detail = entry?.fileName ? `${detail} - ${entry.fileName}` : detail;
        item.label = { label: name, description: item.detail };
        item.labelDetails = { description: item.detail };
        item.insertText = `${name}${context?.needsClosingDelimiter ? context.closingDelimiter || '' : ''}`;
        if (replaceRange) item.range = replaceRange;
        return item;
    }

    function getIncludePathCompletion(document, position, lineTextOverride = null) {
        const line = Number.isInteger(position?.line) ? position.line : -1;
        if (line < 0) return null;
        const lineText = lineTextOverride == null
            ? String(document?.lineAt?.(line)?.text || '')
            : String(lineTextOverride || '');
        const context = getPawnIncludeCompletionContext(lineText, position?.character ?? 0);
        if (!context) return null;

        const prefix = String(context.prefix || '').replace(/\\/g, '/').toLowerCase();
        const replaceRange = makeCompletionRange(line, context.replaceStart, context.replaceEnd);
        const entries = typeof getIncludeCompletionEntries === 'function'
            ? getIncludeCompletionEntries(document?.fileName || '', { delimiter: context.delimiter || '' })
            : [];
        const items = (Array.isArray(entries) ? entries : [])
            .filter(entry => {
                const name = String(entry?.name || '').replace(/\\/g, '/');
                return name && (!prefix || name.toLowerCase().startsWith(prefix));
            })
            .map((entry, index) => makeIncludePathCompletionItem(entry, context, index, replaceRange));
        return { context, items, prefix };
    }

    function getPreprocessorDirectiveCompletion(document, position) {
        const line = Number.isInteger(position?.line) ? position.line : -1;
        if (line < 0) return null;
        const lineText = String(document?.lineAt?.(line)?.text || '');
        if (lineText.indexOf('#') < 0) return null;
        const includeCompletion = getIncludePathCompletion(document, position, lineText);
        if (includeCompletion) return {
            ...includeCompletion,
            includePath: true
        };
        const context = getPreprocessorDirectiveCompletionContext(lineText, position?.character ?? 0);
        if (!context.inPreprocessorLine) return null;

        const prefix = String(context.prefix || '').toLowerCase();
        const replaceRange = makeCompletionRange(line, context.replaceStart, context.replaceEnd);
        const definitions = context.canCompletePragma
            ? PRAGMA_DIRECTIVE_COMPLETIONS
            : PREPROCESSOR_DIRECTIVE_COMPLETIONS;
        const canComplete = context.canCompleteDirective || context.canCompletePragma;
        const items = !canComplete
            ? []
            : definitions
                .map((definition, index) => ({ definition, index }))
                .filter(({ definition }) => !prefix || String(definition.name || '').startsWith(prefix))
                .map(({ definition, index }) => makePreprocessorDirectiveItem(definition, index, replaceRange));

        return { context, items, prefix };
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

    function getServiceKeywordCompletionItems(document, position, replaceRange, ctx, prefix = '', hasExistingStartsWith = false) {
        const candidates = getServiceKeywordCandidatesForPrefix(prefix, hasExistingStartsWith);
        if (!candidates.length) return [];
        const beforeCompletion = getLineTextBeforeCompletion(document, position, replaceRange);
        const statementContext = isStatementStartCompletionText(beforeCompletion);
        const elseContext = isElseCompletionText(beforeCompletion);
        const controlContext = serviceKeywordCandidatesNeedControlContext(candidates)
            ? getCachedCompletionControlContext({
                document,
                position,
                replaceRange,
                ctx,
                classifyPawnStatementLine,
                countStructuralBraces,
                findFirstNonWhitespaceIndex,
                findKeywordOccurrences,
                skipInlineControlHeader
            })
            : null;

        return getCachedServiceKeywordItems(candidates, replaceRange, {
            statementContext,
            elseContext,
            inLoop: !!controlContext?.inLoop,
            inSwitch: !!controlContext?.inSwitch,
            inDirectSwitchBody: !!controlContext?.inDirectSwitchBody
        });
    }

    function getMergedCompletionItems(baseItems, extraItems) {
        if (!Array.isArray(baseItems) || !baseItems.length) return Array.isArray(extraItems) ? extraItems : [];
        if (!Array.isArray(extraItems) || !extraItems.length) return baseItems;
        let perExtraCache = mergedCompletionItemsCache.get(baseItems);
        if (!perExtraCache) {
            perExtraCache = new WeakMap();
            mergedCompletionItemsCache.set(baseItems, perExtraCache);
        }
        const cached = perExtraCache.get(extraItems);
        if (cached) return cached;
        const merged = baseItems.concat(extraItems);
        perExtraCache.set(extraItems, merged);
        return merged;
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
        provideCompletionItems(document, position, _token = null, completionContext = null) {
            const startedAt = Date.now();
            try {
                const fileName = String(document?.fileName || '');
                const line = Number.isInteger(position?.line) ? position.line : -1;
                const character = Number.isInteger(position?.character) ? position.character : -1;
                const triggerCharacter = String(completionContext?.triggerCharacter || '');
                logCompletion(() => `start file=${fileName} pos=${line}:${character} version=${document?.version ?? ''}`);
                if (!isCompletionEnabled()) {
                    logCompletion(() => `skip disabled file=${fileName} ms=${Date.now() - startedAt}`);
                    clearCompletionAutoHideTimer();
                    return [];
                }
                const preprocessorCompletion = getPreprocessorDirectiveCompletion(document, position);
                if (preprocessorCompletion) {
                    const { context, items, prefix, includePath } = preprocessorCompletion;
                    logCompletion(() =>
                        `preprocessor items=${items.length} prefix="${prefix}" ` +
                        `directive=${context.canCompleteDirective ? 1 : 0} pragma=${context.canCompletePragma ? 1 : 0} ` +
                        `includePath=${includePath ? 1 : 0} ` +
                        `file=${fileName} pos=${line}:${character} ms=${Date.now() - startedAt}`
                    );
                    return finalizeCompletionResult(items, prefix);
                }
                if (INCLUDE_COMPLETION_TRIGGER_CHARACTERS.includes(triggerCharacter)) {
                    logCompletion(() =>
                        `skip include-trigger-outside-include trigger="${triggerCharacter}" ` +
                        `file=${fileName} pos=${line}:${character} ms=${Date.now() - startedAt}`
                    );
                    return finalizeCompletionResult([], '');
                }
                const replaceRange = getCompletionReplaceRange(document, position);
                const prefix = replaceRange ? document.getText(replaceRange) : '';
                const contextStartedAt = Date.now();
                const ctx = getPawnDocumentContext(document, position.line);
                const contextMs = Date.now() - contextStartedAt;
                if (!ctx) {
                    logCompletion(() =>
                        `no-context file=${fileName} pos=${line}:${character} lang=${document?.languageId || ''} ` +
                        `contextMs=${contextMs} ms=${Date.now() - startedAt}`
                    );
                    return finalizeCompletionResult([], prefix);
                }
                const { fp, parsedDecls, incDecls } = ctx;
                const { globals, functions, locals, funcArgs } = parsedDecls;
                const forwardBodyStyle = normalizeForwardCompletionBodyStyle(getForwardCompletionBodyStyle());
                const completionIntent = getCachedCompletionIntent(document, position, ctx, replaceRange);
                if (triggerCharacter === '[' && completionIntent !== 'array-dimension') {
                    logCompletion(() =>
                        `skip array-trigger-outside-dimension trigger="${triggerCharacter}" ` +
                        `intent=${completionIntent} file=${fileName} pos=${line}:${character} ` +
                        `contextMs=${contextMs} ms=${Date.now() - startedAt}`
                    );
                    return finalizeCompletionResult([], prefix);
                }
                const insertionContext = completionInsertTextCore.getFunctionCompletionInsertionContext(
                    document,
                    position,
                    replaceRange,
                    {
                        escapeChar: ctx.lineCtrlChars?.[line] || ''
                    }
                );
                const completionCallArgumentMode = completionIntent === 'call'
                    ? normalizeCompletionCallArgumentMode(getCompletionCallArgumentMode())
                    : 'all';
                const completionItemOptions = {
                    forwardBodyStyle,
                    isForwardImplementationContext: forwardBodyStyle !== 'disabled' &&
                        completionIntent === 'top-level-declaration',
                    callInsertMode: insertionContext.shouldInsertCallArguments ? 'call-with-args' : 'name-only',
                    callArgumentMode: completionCallArgumentMode,
                    existingArgumentBlock: insertionContext.existingArgumentBlock,
                    prefixStartsWithAt: String(prefix || '').trimStart().startsWith('@')
                };

                const candidates = getBaseCompletionCandidates(ctx, line, completionIntent);
                const intentCandidates = filterCompletionCandidatesForIntent(candidates, completionIntent);
                const filteredCandidates = filterCompletionCandidatesForPrefix(intentCandidates, prefix);
                const completionCandidates = completionItemOptions.isForwardImplementationContext
                    ? getForwardImplementationCandidates(filteredCandidates.candidates, incDecls)
                    : filteredCandidates.candidates;
                const dedupedCompletionCandidates = dedupeCompletionCandidates(completionCandidates);
                const baseItems = getCandidateCompletionItems(
                    dedupedCompletionCandidates,
                    fp,
                    replaceRange,
                    completionItemOptions
                );
                let items = baseItems;
                if (completionIntent === 'call') {
                    const serviceItems = getServiceKeywordCompletionItems(
                        document,
                        position,
                        replaceRange,
                        ctx,
                        prefix,
                        filteredCandidates.startsWithCount > 0
                    );
                    items = getMergedCompletionItems(baseItems, serviceItems);
                }

                logCompletion(() =>
                    `items=${items.length}/${items.length} candidates=${dedupedCompletionCandidates.length}/${filteredCandidates.candidates.length}/${intentCandidates.length}/${candidates.length} ` +
                    `prefix="${prefix}" mode=${filteredCandidates.mode} candidateMode=${filteredCandidates.mode} ` +
                    `startsWith=${filteredCandidates.startsWithCount} contains=${filteredCandidates.containsCount} fuzzy=${filteredCandidates.fuzzyCount || 0} ` +
                    `file=${fileName} pos=${line}:${character} ` +
                    `callInsert=${completionItemOptions.callInsertMode} callArgs=${completionItemOptions.callArgumentMode} ` +
                    `globals=${globals.length} locals=${locals.length} args=${funcArgs.length} ` +
                    `functions=${functions.length} includes=${incDecls.length} ` +
                    `intent=${completionIntent} contextMs=${contextMs} ms=${Date.now() - startedAt}`
                );
                return finalizeCompletionResult(items, prefix, { isIncomplete: !!prefix });
            } catch (error) {
                logCompletion(() => `error ${error?.stack || String(error)}`);
                console.error('AMXX Pawn completion provider failed:', error);
                return finalizeCompletionResult([], '');
            }
        },

        resolveCompletionItem(item) {
            const startedAt = Date.now();
            try {
                if (!isCompletionEnabled()) {
                    logCompletion(() => `resolve-skip disabled ms=${Date.now() - startedAt}`);
                    return item;
                }
                const data = item._pawnData;
                if (!data) {
                    logCompletion(() => `resolve-skip no-data label=${String(item?.label?.label || item?.label || '')} ms=${Date.now() - startedAt}`);
                    return item;
                }
                logCompletion(() =>
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
                logCompletion(() =>
                    `resolve-done name=${String(data.name || '')} type=${String(data.type || '')} ` +
                    `docs=${docsText ? 1 : 0} ms=${Date.now() - startedAt}`
                );
            } catch (error) {
                logCompletion(() => `resolve-error ms=${Date.now() - startedAt} ${error?.stack || String(error)}`);
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
                ),
                { dispose: clearCompletionAutoHideTimer }
            );
        }
    };
}

module.exports = {
    COMPLETION_TRIGGER_CHARACTERS,
    createCompletionFeature
};
