const { createHoverAccessPlanFeature } = require('./access-plan');
const { createHoverCallPlanFeature } = require('./call-plan');
const { createHoverSessionFactory } = require('./session');
const {
    touchLimitedMap,
    getSemanticSessionMap
} = require('../../core/document-context/semantic-session');

function createHoverBuilderFeature(deps) {
    const {
        vscode,
        t,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        isLinePositionInsideCommentOrString,
        collectIndexedAccessExpressionsFromLine,
        buildIndexedAccessSelectionModel,
        getCtrlCharStateForContent,
        createHoverTypeAnalysisCache,
        findVariableDeclarationSpanInRange,
        shouldSuppressVariableDeclarationValidationInRange,
        isVariableDeclarationNameAtPosition,
        findIndexedAccessContextAtPosition,
        findHeaderFunctionByNameAtPosition,
        findBitmaskExpressionContext,
        findHoveredBitmaskPart,
        findEnumInitializerMemberContext,
        isOriginalDeclarationHover,
        collectWordDeclMatches,
        BUILTIN_DECLS,
        buildStructuredEnumFieldHover,
        buildHoverMarkdown,
        buildArgHoverInfo,
        findDefinitionContext,
        findPreferredKnownCallContext,
        isNearbyCallContext,
        isHoverAtActiveCursor,
        findNestedParentCallNameContext,
        findFunctionCallNameContext,
        getPreferredFunctionHoverMatch,
        extractCallSiteArgs,
        hasIncludeFunctionTwin,
        splitTopLevel,
        parseFuncArgs,
        parseDimsParts,
        createLazyCallContextOptions,
        isKnownFunctionName,
        finalizeDeclMatches,
        extractEnumSymbolName,
        isFunctionLikeDecl,
        resolveArgumentSymbolName,
        getDeclMatchKey,
        applyHoverDisplayNameSuffixToMatches,
        buildCallArgLayout,
        expandObjectLikeDefineTupleCallArgs,
        isMeaningfulCallCursorPosition,
        isMeaningfulCallPosition,
        getHoverCacheSignature = null
    } = deps;
    const semanticHoverCache = new Map();
    const semanticSessionIds = new WeakMap();
    const SEMANTIC_HOVER_CACHE_LIMIT = 128;
    let nextSemanticSessionId = 1;

    const { createHoverSession } = createHoverSessionFactory({
        t,
        getPawnDocumentContext,
        collectIndexedAccessExpressionsFromLine,
        findIndexedAccessContextAtPosition,
        getCtrlCharStateForContent,
        createHoverTypeAnalysisCache
    });

    function getSemanticSessionId(semanticSession) {
        if (!semanticSession || (typeof semanticSession !== 'object' && typeof semanticSession !== 'function')) {
            return 'no-session';
        }
        let id = semanticSessionIds.get(semanticSession);
        if (!id) {
            id = `s${nextSemanticSessionId++}`;
            semanticSessionIds.set(semanticSession, id);
        }
        return id;
    }

    function getDocumentSemanticKey(document, semanticSession = null) {
        const uri = document?.uri?.toString?.() || document?.fileName || '';
        const version = Number.isInteger(document?.version) ? document.version : 0;
        const cacheSignature = typeof getHoverCacheSignature === 'function'
            ? getHoverCacheSignature()
            : '';
        return `${uri}|v${version}|${getSemanticSessionId(semanticSession)}|${cacheSignature}`;
    }

    function getSemanticHoverCacheEntry(key) {
        if (!key) return null;
        const cached = semanticHoverCache.get(key) || null;
        if (!cached) return null;
        semanticHoverCache.delete(key);
        semanticHoverCache.set(key, cached);
        return cached;
    }

    function setSemanticHoverCacheEntry(key, hover) {
        if (!key || !hover) return hover;
        semanticHoverCache.set(key, hover);
        while (semanticHoverCache.size > SEMANTIC_HOVER_CACHE_LIMIT) {
            const oldestKey = semanticHoverCache.keys().next().value;
            semanticHoverCache.delete(oldestKey);
        }
        return hover;
    }

    function buildHoverAtPosition(document, position) {
        const createHoverRangeFromOffsets = (startOffset, endOffset) => {
            if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset < startOffset) {
                return null;
            }
            return new vscode.Range(
                document.positionAt(startOffset),
                document.positionAt(Math.max(startOffset + 1, endOffset))
            );
        };
        const buildEnumDeclarationHeaderHover = enumDecl => {
            if (!enumDecl || enumDecl.type !== 'enum' || enumDecl.lineNumber !== position.line) return null;
            const lineText = document.lineAt(position.line).text;
            const enumMatch = lineText.match(/\benum\b/);
            if (!enumMatch) return null;
            const headerStart = enumMatch.index;
            const braceIndex = lineText.indexOf('{', headerStart);
            const headerEnd = braceIndex >= 0 ? braceIndex : lineText.length;
            if (position.character < headerStart || position.character > headerEnd) return null;

            const hoverRange = createHoverRangeFromOffsets(
                document.offsetAt(new vscode.Position(position.line, headerStart)),
                document.offsetAt(new vscode.Position(position.line, Math.max(headerStart + 1, headerEnd)))
            );
            return new vscode.Hover(
                buildHoverMarkdown(
                    [{ label: t('hover.kind.enum'), data: enumDecl, nav: true }],
                    null,
                    null,
                    allDecls,
                    '',
                    fp,
                    bitmaskCtx,
                    funcArgs,
                    locals,
                    globals,
                    functions,
                    incDecls,
                    bitmaskPartCtx,
                    { hoveredWord: enumDecl.name || enumDecl.enumDisplayName || 'enum', lookup }
                ),
                hoverRange || tokenRange || undefined
            );
        };
        const hoverSession = createHoverSession(document, position);
        if (!hoverSession) return null;
        const {
            ctx,
            fp,
            text,
            resolver,
            parsedDecls,
            globals,
            functions,
            locals,
            funcArgs,
            incDecls,
            lookup,
            allDecls,
            declarationSourceState,
            getScopedWordMatchesCache,
            getRawIndexedExpressionsForLine,
            findIndexedAccessContextAtPositionCached
        } = hoverSession;
        const documentSemanticKey = getDocumentSemanticKey(document, ctx.semanticSession || null);
        const lineText = document.lineAt(position.line).text;
        const inCommentOrString = isLinePositionInsideCommentOrString(
            lineText,
            Math.min(position.character, lineText.length),
            resolver.ctrlCharAtLine(position.line)
        );
        const token = getLookupTokenAtPosition(document, position, { ctrlCharResolver: resolver });
        const isOperatorToken = !!token?.isOperator;
        const word = (inCommentOrString || isOperatorToken) ? null : (token?.text || null);
        const tokenRange = token?.range || null;
        const lineStartOffset = document.offsetAt(new vscode.Position(position.line, 0));
        const positionOffset = document.offsetAt(position);
        const variableDecls = [...funcArgs, ...locals, ...globals];
        const findTaggedIndexedAccessContextAtPosition = hoverPosition => {
            const rawLineText = document.lineAt(hoverPosition.line).text;
            const expressions = getRawIndexedExpressionsForLine(hoverPosition.line, rawLineText);
            const column = hoverPosition.character;
            for (const expr of expressions) {
                if (column >= expr.baseStart || column < 0) continue;
                const prefix = rawLineText.slice(0, expr.baseStart);
                const tagMatch = prefix.match(/([A-Za-z_@]\w*)\s*:\s*$/);
                if (!tagMatch) continue;
                const tagStart = tagMatch.index;
                const tagCastEnd = expr.baseStart;
                if (column < tagStart || column >= tagCastEnd) continue;
                return {
                    ...expr,
                    activeAccessIndex: null,
                    tagStart,
                    tagEnd: tagStart + tagMatch[1].length,
                    tagCastEnd
                };
            }
            return null;
        };
        const callContextOptions = createLazyCallContextOptions(document, ctx.semanticSession || null);
        const getPositionCacheKey = hoverPosition =>
            `${documentSemanticKey}|${hoverPosition?.line ?? -1}:${hoverPosition?.character ?? -1}`;
        const isSamePosition = (left, right) =>
            !!left &&
            !!right &&
            left.line === right.line &&
            left.character === right.character;
        const findPreferredKnownCallContextCached = hoverPosition => {
            const cache = getSemanticSessionMap(ctx.semanticSession || null, 'hoverPreferredKnownCallContextByPosition');
            const key = `${getPositionCacheKey(hoverPosition)}|preferred-known-call`;
            if (cache?.has(key)) return cache.get(key);
            const value = findPreferredKnownCallContext(
                document,
                hoverPosition,
                functions,
                incDecls,
                lookup,
                callContextOptions
            );
            return cache ? touchLimitedMap(cache, key, value, 256) : value;
        };
        const findNestedParentCallNameContextCached = hoverPosition => {
            const cache = getSemanticSessionMap(ctx.semanticSession || null, 'hoverNestedParentCallNameContextByPosition');
            const key = `${getPositionCacheKey(hoverPosition)}|nested-parent-call-name`;
            if (cache?.has(key)) return cache.get(key);
            const value = findNestedParentCallNameContext(
                document,
                hoverPosition,
                functions,
                incDecls,
                lookup,
                callContextOptions
            );
            return cache ? touchLimitedMap(cache, key, value, 256) : value;
        };
        const findFunctionCallNameContextCached = (hoverPosition, activeCtx) => {
            const cache = getSemanticSessionMap(ctx.semanticSession || null, 'hoverFunctionCallNameContextByPosition');
            const activeKey = activeCtx
                ? `${activeCtx.funcName || ''}@${activeCtx.openOffset ?? -1}:${activeCtx.closeOffset ?? -1}:${activeCtx.argIndex ?? -1}`
                : 'none';
            const key = `${getPositionCacheKey(hoverPosition)}|function-call-name|${activeKey}`;
            if (cache?.has(key)) return cache.get(key);
            const value = findFunctionCallNameContext(
                document,
                hoverPosition,
                functions,
                incDecls,
                activeCtx,
                lookup,
                callContextOptions
            );
            return cache ? touchLimitedMap(cache, key, value, 256) : value;
        };
        const extractCallSiteArgsCached = openOffset => {
            const boundedOpenOffset = Number.isInteger(openOffset) ? openOffset : -1;
            if (boundedOpenOffset < 0) return extractCallSiteArgs(text, openOffset);
            const cache = getSemanticSessionMap(ctx.semanticSession || null, 'hoverCallSiteArgsByOpenOffset');
            const key = `${documentSemanticKey}|call-site-args|${boundedOpenOffset}`;
            if (cache?.has(key)) return cache.get(key);
            const value = extractCallSiteArgs(text, boundedOpenOffset);
            return cache ? touchLimitedMap(cache, key, value, 512) : value;
        };
        const buildCallArgLayoutCached = (signatureArgs, rawCallSiteArgs, currentArgIndex = null) => {
            const cache = getSemanticSessionMap(ctx.semanticSession || null, 'hoverCallArgLayoutBySignature');
            if (!cache) return buildCallArgLayout(signatureArgs, rawCallSiteArgs, currentArgIndex);
            const callArgsKey = Array.isArray(rawCallSiteArgs)
                ? rawCallSiteArgs.join('\u0001')
                : '';
            const key = [
                documentSemanticKey,
                'call-arg-layout',
                String(signatureArgs || ''),
                currentArgIndex ?? -1,
                callArgsKey
            ].join('\u0000');
            if (cache.has(key)) return cache.get(key);
            const value = buildCallArgLayout(signatureArgs, rawCallSiteArgs, currentArgIndex);
            return touchLimitedMap(cache, key, value, 512);
        };
        const getWordMatches = targetName => {
            const key = String(targetName || '');
            if (!key) return [];
            const cache = getScopedWordMatchesCache();
            if (cache.has(key)) return cache.get(key);
            const matches = collectWordDeclMatches(
                key,
                funcArgs,
                locals,
                globals,
                functions,
                incDecls,
                BUILTIN_DECLS,
                lookup
            );
            cache.set(key, matches);
            return matches;
        };
        const getVariableWordMatches = targetName => {
            const key = String(targetName || '');
            if (!key) return [];
            const localMatches = [];
            const pushLocalVariable = (label, data, nav) => {
                if (data?.type === 'variable') {
                    localMatches.push({ label, data, nav });
                }
            };
            pushLocalVariable(t('hover.kind.argument'), lookup.findFuncArg(key), false);
            pushLocalVariable(t('hover.kind.local'), lookup.findLocal(key), false);
            pushLocalVariable(t('hover.kind.global'), lookup.findGlobal(key), true);
            return localMatches.length
                ? localMatches
                : getWordMatches(key).filter(match => match.data.type === 'variable');
        };
        const getLocalFirstWordMatches = targetName => {
            const key = String(targetName || '');
            if (!key) return [];
            const localMatches = [];
            const pushMatch = (label, data, nav) => {
                if (data) localMatches.push({ label, data, nav });
            };
            pushMatch(t('hover.kind.argument'), lookup.findFuncArg(key), false);
            pushMatch(t('hover.kind.local'), lookup.findLocal(key), true);
            const globalMatch = lookup.findGlobal(key);
            pushMatch(
                globalMatch?.type === 'enum-item'
                    ? t('hover.enumField')
                    : (globalMatch?.type === 'enum' ? t('hover.kind.enum') : t('hover.kind.global')),
                globalMatch,
                true
            );
            pushMatch(t('hover.kind.function'), lookup.findFunction(key), true);
            for (const builtin of lookup.filterBuiltins(key)) {
                pushMatch(t('hover.kind.compiler'), builtin, false);
            }
            return localMatches.length ? localMatches : getWordMatches(key);
        };
        const buildDistinctArgHoverInfo = (matchList, includeDocs = false, options = {}) => {
            const seen = new Set();
            const unique = [];
            for (const match of matchList || []) {
                if (!match?.data) continue;
                const key = getDeclMatchKey(match.data);
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(match);
            }
            return buildArgHoverInfo(unique, fp, includeDocs, options);
        };
        const declarationSpanAtPosition = findVariableDeclarationSpanInRange(
            document,
            positionOffset,
            positionOffset,
            variableDecls,
            resolver,
            text,
            declarationSourceState
        );
        const declarationDimHoverInfo = declarationSpanAtPosition ? (() => {
            const lineText = document.lineAt(position.line).text;
            const lineStartOffset = document.offsetAt(new vscode.Position(position.line, 0));
            const column = positionOffset - lineStartOffset;
            const dimRe = /\[([^\]]+)\]/g;
            let match = null;
            let dimIndex = 0;
            while ((match = dimRe.exec(lineText))) {
                if (column < match.index || column >= match.index + match[0].length) {
                    dimIndex++;
                    continue;
                }
                return {
                    enumName: extractEnumSymbolName(match[1]),
                    activeDimIndex: dimIndex
                };
            }
            return null;
        })() : '';
        const declarationDimEnumHoverName = declarationDimHoverInfo?.enumName || '';
        if (shouldSuppressVariableDeclarationValidationInRange(
            document,
            positionOffset,
            positionOffset,
            ctx,
            [...locals, ...globals],
            declarationSourceState,
            word
        ) && !declarationDimEnumHoverName) {
            return null;
        }
        const isVariableDeclarationHover = word
            ? isVariableDeclarationNameAtPosition(document, position, variableDecls, resolver, text)
            : false;
        let indexedAccessContext = !isVariableDeclarationHover
            ? findIndexedAccessContextAtPositionCached(position)
            : null;
        if (
            indexedAccessContext &&
            declarationSpanAtPosition?.decl?.type === 'variable' &&
            declarationSpanAtPosition.decl.name === indexedAccessContext.baseName
        ) {
            indexedAccessContext = null;
        }
        const wordAccessSuffix =
            word && indexedAccessContext?.baseName === word
                ? indexedAccessContext.suffix
                : '';
        const wordAccessActiveIndex =
            wordAccessSuffix && indexedAccessContext?.activeAccessIndex != null
                ? indexedAccessContext.activeAccessIndex
                : null;
        const indexedAccessHoverCtx =
            indexedAccessContext && indexedAccessContext.activeAccessIndex != null
                ? indexedAccessContext
                : null;
        const declarationNameCtx = findHeaderFunctionByNameAtPosition(document, position, functions, resolver);
        const bitmaskCtx = findBitmaskExpressionContext(document, position, allDecls);
        const bitmaskPartCtx = findHoveredBitmaskPart(document, position, allDecls);
        const enumInitializerCtx = findEnumInitializerMemberContext(
            document,
            position,
            [...globals, ...locals]
        );
        const enumDeclarationHover = globals
            .filter(item => item?.type === 'enum' && item.lineNumber === position.line)
            .map(buildEnumDeclarationHeaderHover)
            .find(Boolean) || null;

        if (enumDeclarationHover) {
            return enumDeclarationHover;
        }

        if (isOriginalDeclarationHover(document, position, functions, globals, locals, funcArgs, incDecls, resolver, lookup)) {
            return null;
        }

        const definitionCtx = findDefinitionContext(document, position, functions);

        if (enumInitializerCtx) {
            const prefixMatches = enumInitializerCtx.fieldExpr && word
                ? getWordMatches(word)
                : [];
            return new vscode.Hover(
                buildStructuredEnumFieldHover(
                    enumInitializerCtx.enumDecl,
                    enumInitializerCtx.member,
                    enumInitializerCtx.fieldExpr,
                    fp,
                    enumInitializerCtx.escapeChar,
                    allDecls,
                    prefixMatches,
                    bitmaskCtx,
                    funcArgs,
                    locals,
                    globals,
                    functions,
                    incDecls
                ),
                tokenRange || undefined
            );
        }

        if (declarationDimEnumHoverName) {
            const declarationDimDefinitionCtx = findDefinitionContext(document, position, functions);
            const declarationDimHeaderNameCtx = declarationDimDefinitionCtx
                ? null
                : findHeaderFunctionByNameAtPosition(document, position, functions, resolver);
            const declarationDimHeaderTwinName = declarationDimDefinitionCtx?.funcName || declarationDimHeaderNameCtx?.name || '';
            const declarationDimHasHeaderTwin = declarationDimHeaderTwinName &&
                hasIncludeFunctionTwin(declarationDimHeaderTwinName, incDecls, lookup);
            if (declarationDimHasHeaderTwin && declarationDimDefinitionCtx) {
                const declarationDimHeaderTwinMatch = getPreferredFunctionHoverMatch(
                    declarationDimHeaderTwinName,
                    functions,
                    incDecls,
                    { preferInclude: true },
                    lookup
                );
                if (declarationDimHeaderTwinMatch) {
                    const declarationDimHeaderCallSiteArgs = extractCallSiteArgsCached(declarationDimDefinitionCtx.openOffset);
                    const declarationDimHeaderArgMatches = [];
                    const includeArgDecls = parseFuncArgs(
                        declarationDimHeaderTwinMatch.data.args || '',
                        declarationDimHeaderTwinMatch.data.filePath,
                        declarationDimHeaderTwinMatch.data.file,
                        declarationDimHeaderTwinMatch.data.lineNumber
                    );
                    const includeArgDecl = includeArgDecls[declarationDimDefinitionCtx.argIndex] || null;
                    if (includeArgDecl) {
                        declarationDimHeaderArgMatches.push({
                            label: t('hover.kind.argument'),
                            data: includeArgDecl,
                            nav: !!includeArgDecl.filePath
                        });
                    }
                    const declarationDimEnumMatches = getWordMatches(declarationDimEnumHoverName);
                    const declarationDimHoverMarkdown = buildHoverMarkdown(
                        [declarationDimHeaderTwinMatch],
                        declarationDimDefinitionCtx.argIndex,
                        declarationDimHeaderCallSiteArgs,
                        allDecls,
                        buildArgHoverInfo(declarationDimHeaderArgMatches, fp, false),
                        fp,
                        bitmaskCtx,
                        funcArgs,
                        locals,
                        globals,
                        functions,
                        incDecls,
                        bitmaskPartCtx,
                        {
                            validateSignatureArgs: true,
                            signatureValidationMode: 'declaration',
                            forceColoredSignature: true,
                            hoveredWord: declarationSpanAtPosition?.decl?.name || '',
                            lookup
                        }
                    );
                    if (declarationDimEnumMatches.length) {
                        const declarationDimEnumMarkdown = buildHoverMarkdown(
                            declarationDimEnumMatches,
                            null,
                            null,
                            allDecls,
                            '',
                            fp,
                            null,
                            funcArgs,
                            locals,
                            globals,
                            functions,
                            incDecls,
                            null,
                            {
                                hoveredWord: declarationDimEnumHoverName,
                                lookup
                            }
                        );
                        declarationDimHoverMarkdown.appendMarkdown('\n\n---\n\n');
                        declarationDimHoverMarkdown.appendMarkdown(declarationDimEnumMarkdown.value);
                    }
                    return new vscode.Hover(
                        declarationDimHoverMarkdown,
                        createHoverRangeFromOffsets(
                            declarationDimDefinitionCtx.openOffset,
                            declarationDimDefinitionCtx.closeOffset != null
                                ? declarationDimDefinitionCtx.closeOffset + 1
                                : declarationDimDefinitionCtx.openOffset + 1
                        ) || tokenRange || undefined
                    );
                }
            }
            if (!declarationDimHasHeaderTwin) {
                const enumMatches = getWordMatches(declarationDimEnumHoverName);
                if (enumMatches.length) {
                    return new vscode.Hover(
                        buildHoverMarkdown(
                            enumMatches,
                            null,
                            null,
                            allDecls,
                            '',
                            fp,
                            null,
                            funcArgs,
                            locals,
                            globals,
                            functions,
                            incDecls,
                            null,
                            { hoveredWord: declarationDimEnumHoverName, lookup }
                        ),
                        tokenRange || createHoverRangeFromOffsets(
                            document.offsetAt(new vscode.Position(position.line, Math.max(0, position.character - 1))),
                            document.offsetAt(new vscode.Position(position.line, Math.min(document.lineAt(position.line).text.length, position.character + 1)))
                        ) || undefined
                    );
                }

                const declarationDimDecl = declarationSpanAtPosition?.decl || null;
                const declarationDimVariableMatches = declarationDimDecl?.name
                    ? getVariableWordMatches(declarationDimDecl.name)
                    : [];
                if (declarationDimDecl?.type === 'variable' && declarationDimVariableMatches.length) {
                    return new vscode.Hover(
                        buildHoverMarkdown(
                            declarationDimVariableMatches,
                            null,
                            null,
                            allDecls,
                            '',
                            fp,
                            bitmaskCtx,
                            funcArgs,
                            locals,
                            globals,
                            functions,
                            incDecls,
                            bitmaskPartCtx,
                            {
                                variableAccessSuffix: declarationDimDecl.dims || '',
                                variableAccessActiveIndex: declarationDimHoverInfo?.activeDimIndex ?? 0,
                                validateVariableAccess: false,
                                hoveredWord: declarationDimDecl.name,
                                lookup
                            }
                        ),
                        tokenRange || createHoverRangeFromOffsets(
                            document.offsetAt(new vscode.Position(position.line, Math.max(0, position.character - 1))),
                            document.offsetAt(new vscode.Position(position.line, Math.min(document.lineAt(position.line).text.length, position.character + 1)))
                        ) || undefined
                    );
                }
            }
        }

        const getDisplayAccessIndex = accessCtx =>
            accessCtx?.accesses?.length
                ? (accessCtx.activeAccessIndex != null ? accessCtx.activeAccessIndex : 0)
                : null;
        const getDeclarationAccessIndex = (match, accessCtx) => {
            const accessIndex = getDisplayAccessIndex(accessCtx);
            if (accessIndex == null) return null;
            const dimParts = parseDimsParts(match?.data?.dims || '');
            const dimCount = Array.isArray(dimParts) ? dimParts.length : 0;
            return dimCount > 0 ? Math.min(accessIndex, dimCount - 1) : accessIndex;
        };
        const withDeclarationDisplayName = match => {
            if (!match?.data?.hoverDisplayName) return match;
            return {
                ...match,
                data: {
                    ...match.data,
                    hoverDisplayName: ''
                }
            };
        };
        const withHoverDisplayName = (match, hoverDisplayName) => {
            if (!match?.data || !hoverDisplayName) return match;
            return {
                ...match,
                data: {
                    ...match.data,
                    hoverDisplayName
                }
            };
        };
        const buildFullSymbolHoverInfo = (match, hoveredWord = '') => {
            if (!match?.data) return '';
            const markdown = buildHoverMarkdown(
                [withDeclarationDisplayName(match)],
                null,
                null,
                allDecls,
                '',
                fp,
                null,
                funcArgs,
                locals,
                globals,
                functions,
                incDecls,
                null,
                {
                    hoveredWord: hoveredWord || match.data.name || '',
                    lookup
                }
            );
            return typeof markdown?.value === 'string' ? markdown.value : String(markdown || '');
        };
        const joinHoverSections = (...sections) =>
            sections.filter(Boolean).join('\n\n---\n\n');
        const buildAccessHover = ({
            matches: accessMatches,
            secondaryHoverInfo = '',
            hoverRange = null,
            hoveredWord = '',
            variableAccessSuffix = '',
            variableAccessActiveIndex = null,
            suppressVariableEnumSections = true,
            suppressDescriptions = true,
            hoverBitmaskPartCtx = bitmaskPartCtx
        }) => new vscode.Hover(
            buildHoverMarkdown(
                accessMatches,
                null,
                null,
                allDecls,
                secondaryHoverInfo,
                fp,
                bitmaskCtx,
                funcArgs,
                locals,
                globals,
                functions,
                incDecls,
                hoverBitmaskPartCtx,
                {
                    suppressVariableEnumSections,
                    suppressDescriptions,
                    hoveredWord,
                    variableAccessSuffix,
                    variableAccessActiveIndex,
                    lookup
                }
            ),
            hoverRange || tokenRange || undefined
        );
        const buildAccessModelForContext = accessCtx => buildIndexedAccessSelectionModel(
            accessCtx,
            accessCtx?.accesses?.[accessCtx?.activeAccessIndex]?.start ?? -1,
            resolver.ctrlCharAtLine(position.line),
            {
                resolveSymbolName: expr => resolveArgumentSymbolName(null, expr, '') || ''
            }
        );
        const { resolveAccessHoverPlan: buildAccessHoverPlan } = createHoverAccessPlanFeature({
            buildAccessModelForContext,
            getVariableWordMatches,
            getLocalFirstWordMatches,
            getDeclMatchKey,
            getDisplayAccessIndex,
            getDeclarationAccessIndex,
            withDeclarationDisplayName,
            withHoverDisplayName,
            buildSymbolHoverInfo: (matchList, options = {}) => buildArgHoverInfo(
                matchList,
                fp,
                false,
                { allDecls, lookup, ...options }
            ),
            buildDistinctSymbolHoverInfo: matchList => buildDistinctArgHoverInfo(
                matchList,
                false,
                { allDecls, lookup }
            ),
            buildFullSymbolHoverInfo,
            createHoverRangeFromOffsets,
            joinHoverSections
        });
        const taggedIndexedAccessCtx = findTaggedIndexedAccessContextAtPosition(position);
        if (taggedIndexedAccessCtx) {
            const tagBaseMatches = getVariableWordMatches(taggedIndexedAccessCtx.baseName);
            if (tagBaseMatches.length) {
                return new vscode.Hover(
                    buildHoverMarkdown(
                        tagBaseMatches,
                        null,
                        null,
                        allDecls,
                        '',
                        fp,
                        bitmaskCtx,
                        funcArgs,
                        locals,
                        globals,
                        functions,
                        incDecls,
                        bitmaskPartCtx,
                        {
                            suppressDescriptions: true,
                            hoveredWord: taggedIndexedAccessCtx.baseName,
                            lookup
                        }
                    ),
                    createHoverRangeFromOffsets(
                        lineStartOffset + taggedIndexedAccessCtx.tagStart,
                        lineStartOffset + taggedIndexedAccessCtx.tagCastEnd
                    ) || tokenRange || undefined
                );
            }
        }

        if (
            indexedAccessContext &&
            word &&
            word === indexedAccessContext.baseName &&
            position.character >= indexedAccessContext.baseStart &&
            position.character < indexedAccessContext.baseEnd
        ) {
            const baseVariableMatches = getVariableWordMatches(indexedAccessContext.baseName);
            if (baseVariableMatches.length) {
                return new vscode.Hover(
                    buildHoverMarkdown(
                        baseVariableMatches,
                        null,
                        null,
                        allDecls,
                        '',
                        fp,
                        bitmaskCtx,
                        funcArgs,
                        locals,
                        globals,
                        functions,
                        incDecls,
                        bitmaskPartCtx,
                        {
                            hoveredWord: indexedAccessContext.baseName,
                            lookup
                        }
                    ),
                    tokenRange || createHoverRangeFromOffsets(
                        lineStartOffset + indexedAccessContext.baseStart,
                        lineStartOffset + indexedAccessContext.baseEnd
                    ) || undefined
                );
            }
        }

        if (indexedAccessHoverCtx) {
            const accessModel = buildIndexedAccessSelectionModel(
                indexedAccessHoverCtx,
                position.character,
                resolver.ctrlCharAtLine(position.line),
                {
                    hoveredWord: word || '',
                    resolveSymbolName: expr => resolveArgumentSymbolName(null, expr, '') || ''
                }
            );
            const accessHoverPlan = buildAccessHoverPlan(indexedAccessHoverCtx, accessModel, {
                lineStartOffset,
                hoveredWord: word || ''
            });
            if (accessHoverPlan) return buildAccessHover(accessHoverPlan);
        }
        const rawCallCtx = definitionCtx
            ? null
            : findPreferredKnownCallContextCached(position);
        const callCtx = rawCallCtx && isNearbyCallContext(document, position, rawCallCtx)
            ? rawCallCtx
            : null;
        const hoverAtCursor = isHoverAtActiveCursor(document, position);
        const activeEditor = vscode.window.activeTextEditor;
        const activeCursorPos =
            activeEditor && activeEditor.document.uri.toString() === document.uri.toString()
                ? activeEditor.selection.active
                : null;
        const rawActiveCallCtx = activeCursorPos
            ? (isSamePosition(activeCursorPos, position) && !definitionCtx
                ? rawCallCtx
                : findPreferredKnownCallContextCached(activeCursorPos))
            : null;
        const activeCallCtx = rawActiveCallCtx && activeCursorPos &&
            isNearbyCallContext(document, activeCursorPos, rawActiveCallCtx)
                ? rawActiveCallCtx
                : null;
        const nestedCallNameInfo = declarationNameCtx
            ? { callNameCtx: null, parentCallCtx: null }
            : findNestedParentCallNameContextCached(position);
        const callNameCtx = nestedCallNameInfo.callNameCtx ||
            findFunctionCallNameContextCached(position, activeCallCtx);
        const nestedParentCallCtx = nestedCallNameInfo.parentCallCtx;
        const nestedFunctionArgCtx =
            callNameCtx && nestedParentCallCtx && word === callNameCtx.funcName
                ? { parent: nestedParentCallCtx, child: callNameCtx }
                : null;
        const nestedFunctionNameHover = !!nestedFunctionArgCtx;
        if (nestedFunctionArgCtx) {
            const parentMatch = getPreferredFunctionHoverMatch(
                nestedFunctionArgCtx.parent.funcName,
                functions,
                incDecls,
                {},
                lookup
            );
            const childMatch = getPreferredFunctionHoverMatch(
                nestedFunctionArgCtx.child.funcName,
                functions,
                incDecls,
                {},
                lookup
            );

            if (parentMatch) {
                const parentCallSiteArgs = extractCallSiteArgsCached(nestedFunctionArgCtx.parent.openOffset);
                const nestedArgMatches = childMatch ? [childMatch] : [];
                return new vscode.Hover(
                    buildHoverMarkdown(
                        [parentMatch],
                        nestedFunctionArgCtx.parent.argIndex,
                        parentCallSiteArgs,
                        allDecls,
                        buildArgHoverInfo(nestedArgMatches, fp, false),
                        fp,
                        bitmaskCtx,
                        funcArgs,
                        locals,
                        globals,
                        functions,
                        incDecls,
                        null,
                        { variableAccessSuffix: wordAccessSuffix, variableAccessActiveIndex: wordAccessActiveIndex, hoveredWord: word, lookup }
                    ),
                    createHoverRangeFromOffsets(
                        nestedFunctionArgCtx.parent.openOffset,
                        nestedFunctionArgCtx.parent.closeOffset != null
                            ? nestedFunctionArgCtx.parent.closeOffset + 1
                            : nestedFunctionArgCtx.parent.openOffset + 1
                    ) || tokenRange || undefined
                );
            }
        }

        const headerTwinMatchName = declarationNameCtx?.name || definitionCtx?.funcName || '';
        const headerTwinMatch = headerTwinMatchName && hasIncludeFunctionTwin(headerTwinMatchName, incDecls, lookup)
            ? getPreferredFunctionHoverMatch(
                headerTwinMatchName,
                functions,
                incDecls,
                { preferInclude: true },
                lookup
            )
            : null;
        if (headerTwinMatch) {
            const headerArgIndex = definitionCtx?.argIndex ?? null;
            const headerCallSiteArgs = definitionCtx
                ? extractCallSiteArgsCached(definitionCtx.openOffset)
                : splitTopLevel(
                    declarationNameCtx?.args || '',
                    resolver.ctrlCharAtLine(position.line)
                );
            const headerArgHoverMatches = [];
            if (definitionCtx && headerArgIndex != null) {
                const includeArgDecls = parseFuncArgs(
                    headerTwinMatch.data.args || '',
                    headerTwinMatch.data.filePath,
                    headerTwinMatch.data.file,
                    headerTwinMatch.data.lineNumber
                );
                const includeArgDecl = includeArgDecls[headerArgIndex] || null;
                if (includeArgDecl) {
                    headerArgHoverMatches.push({
                        label: t('hover.kind.argument'),
                        data: includeArgDecl,
                        nav: !!includeArgDecl.filePath
                    });
                }
            }

            return new vscode.Hover(
                buildHoverMarkdown(
                    [headerTwinMatch],
                    headerArgIndex,
                    headerCallSiteArgs,
                    allDecls,
                    buildArgHoverInfo(headerArgHoverMatches, fp, headerArgIndex == null),
                    fp,
                    bitmaskCtx,
                    funcArgs,
                    locals,
                    globals,
                    functions,
                    incDecls,
                    bitmaskPartCtx,
                    {
                        validateSignatureArgs: true,
                        signatureValidationMode: 'declaration',
                        forceColoredSignature: true,
                        variableAccessSuffix: wordAccessSuffix,
                        variableAccessActiveIndex: wordAccessActiveIndex,
                        hoveredWord: word,
                        lookup
                    }
                ),
                (definitionCtx
                    ? createHoverRangeFromOffsets(
                        definitionCtx.openOffset,
                        definitionCtx.closeOffset != null ? definitionCtx.closeOffset + 1 : definitionCtx.openOffset + 1
                    )
                    : tokenRange) || undefined
            );
        }

        const nestedSignatureCtx = nestedFunctionArgCtx?.parent || null;
        const signatureCallCtx = nestedSignatureCtx
            ? nestedParentCallCtx
            : (callCtx || callNameCtx || (word && activeCallCtx?.funcName === word ? activeCallCtx : null));
        const displayCallCtx = signatureCallCtx ||
            (word && activeCallCtx?.funcName === word ? activeCallCtx : null);
        const shouldShowCallSignatureHover = !!displayCallCtx && (
            hoverAtCursor ||
            word === displayCallCtx.funcName ||
            nestedFunctionNameHover ||
            (hoverAtCursor
                ? isMeaningfulCallCursorPosition(document, position, displayCallCtx, callContextOptions)
                : isMeaningfulCallPosition(document, position, displayCallCtx, callContextOptions))
        );

        let targetFunc = null;
        let argIndex = null;
        let callSiteArgs = null;

        const matches = [];
        const pushMatches = (targetName, options = {}) => {
            const preferSingleFunction = !!options.preferSingleFunction;
            const preferInclude = !!options.preferInclude;
            const skipIncludesIfLocalMatch = !!options.skipIncludesIfLocalMatch;
            const fa = lookup.findFuncArg(targetName);
            const lo = lookup.findLocal(targetName);
            const gl = lookup.findGlobal(targetName);
            const ff = lookup.findFunction(targetName);
            const hasLocalMatch = !!(fa || lo || gl || ff);
            const ii = skipIncludesIfLocalMatch && hasLocalMatch
                ? []
                : lookup.filterIncludes(targetName);
            const bb = lookup.filterBuiltins(targetName);

            if (preferSingleFunction) {
                const preferredFunctionMatch = getPreferredFunctionHoverMatch(
                    targetName,
                    functions,
                    incDecls,
                    { preferInclude },
                    lookup
                );
                if (preferredFunctionMatch) {
                    matches.push(preferredFunctionMatch);
                    return;
                }
            }

            if (fa) matches.push({ label: t('hover.kind.argument'), data: fa, nav: false });
            if (lo) matches.push({ label: t('hover.kind.local'), data: lo, nav: false });
            if (gl) matches.push({ label: t('hover.kind.global'), data: gl, nav: true });
            if (ff) matches.push({ label: t('hover.kind.function'), data: ff, nav: true });
            for (const d of ii) matches.push({ label: t('hover.kind.include'), data: d, nav: true });
            for (const d of bb) matches.push({ label: t('hover.kind.compiler'), data: d, nav: false });
        };

        if (definitionCtx) {
            targetFunc = definitionCtx.funcName;
            argIndex = definitionCtx.argIndex;
            callSiteArgs = extractCallSiteArgsCached(definitionCtx.openOffset);
            pushMatches(targetFunc, {
                preferSingleFunction: true,
                preferInclude: hasIncludeFunctionTwin(targetFunc, incDecls, lookup)
            });
        } else if (nestedSignatureCtx) {
            targetFunc = nestedSignatureCtx.funcName;
            argIndex = nestedSignatureCtx.argIndex;
            callSiteArgs = extractCallSiteArgsCached(nestedSignatureCtx.openOffset);
            pushMatches(targetFunc, { preferSingleFunction: true });
        } else if (shouldShowCallSignatureHover) {
            targetFunc = displayCallCtx.funcName;
            argIndex = displayCallCtx.argIndex;
            callSiteArgs = extractCallSiteArgsCached(displayCallCtx.openOffset);
            pushMatches(targetFunc, { preferSingleFunction: true });
        } else if (word) {
            const localWordFunc = lookup.findFunction(word);
            const hasLocalWordMatch = !!(
                lookup.findFuncArg(word) ||
                lookup.findLocal(word) ||
                lookup.findGlobal(word) ||
                localWordFunc
            );
            const isKnownFunction = localWordFunc
                ? true
                : (!hasLocalWordMatch && isKnownFunctionName(word, functions, incDecls, lookup));
            targetFunc = word;

            if (declarationNameCtx && isKnownFunction) {
                const declarationFunctionMatch = getPreferredFunctionHoverMatch(
                    word,
                    functions,
                    incDecls,
                    { preferInclude: true },
                    lookup
                );
                if (declarationFunctionMatch) {
                    matches.push(declarationFunctionMatch);
                } else {
                    pushMatches(word, { preferSingleFunction: true });
                }
            } else {
                pushMatches(word, {
                    preferSingleFunction: isKnownFunction,
                    skipIncludesIfLocalMatch: hasLocalWordMatch && !isKnownFunction
                });
            }
        }

        if (!matches.length) {
            if (!bitmaskCtx && !bitmaskPartCtx) return null;
            return new vscode.Hover(
                buildHoverMarkdown(
                    [],
                    null,
                    null,
                    allDecls,
                    '',
                    fp,
                    bitmaskCtx,
                    funcArgs,
                    locals,
                    globals,
                    functions,
                    incDecls,
                    bitmaskPartCtx,
                    { variableAccessSuffix: wordAccessSuffix, variableAccessActiveIndex: wordAccessActiveIndex, hoveredWord: word, lookup }
                ),
                tokenRange || undefined
            );
        }

        const dedupedMatches = finalizeDeclMatches(
            matches.map(match => match.data),
            lookup.argSet,
            lookup.localSet,
            lookup.globalSet,
            lookup.functionSet
        );
        matches.length = 0;
        matches.push(...dedupedMatches);

        if (shouldShowCallSignatureHover && targetFunc) {
            const preferredCallMatch = getPreferredFunctionHoverMatch(
                targetFunc,
                functions,
                incDecls,
                { preferInclude: hasIncludeFunctionTwin(targetFunc, incDecls, lookup) },
                lookup
            );
            if (
                preferredCallMatch &&
                !matches.some(match =>
                    match?.data?.name === preferredCallMatch.data.name &&
                    match?.data?.filePath === preferredCallMatch.data.filePath &&
                    match?.data?.lineNumber === preferredCallMatch.data.lineNumber
                )
            ) {
                matches.unshift(preferredCallMatch);
            }
        }

        const activeSignatureCtx = nestedSignatureCtx || displayCallCtx;
        const shouldShowArgHoverInfo = !!definitionCtx ||
            !!(activeSignatureCtx && targetFunc === activeSignatureCtx.funcName);
        const signatureData = matches.find(match => isFunctionLikeDecl(match.data))?.data || null;
        let signatureArgLayout =
            signatureData && activeSignatureCtx && !definitionCtx
                ? buildCallArgLayoutCached(
                    signatureData.args || '',
                    callSiteArgs,
                    activeSignatureCtx.argIndex
                )
                : null;
        if (
            signatureArgLayout &&
            Array.isArray(callSiteArgs) &&
            callSiteArgs.length < (signatureArgLayout.params?.length || 0)
        ) {
            const callEscapeChar = ctx.resolver?.ctrlCharAtOffset?.(activeSignatureCtx.openOffset) ||
                ctx.resolver?.ctrlCharAtLine?.(activeSignatureCtx.lineNumber ?? position.line) ||
                '';
            const expandedCallSiteArgs = expandObjectLikeDefineTupleCallArgs(callSiteArgs, lookup, callEscapeChar);
            if (expandedCallSiteArgs !== callSiteArgs) {
                callSiteArgs = expandedCallSiteArgs;
                signatureArgLayout = buildCallArgLayoutCached(
                    signatureData.args || '',
                    callSiteArgs,
                    activeSignatureCtx.argIndex
                );
            }
        }

        const { resolveSemanticCallHoverPlan } = createHoverCallPlanFeature({
            t,
            lookup,
            functions,
            incDecls,
            funcArgs,
            parseFuncArgs,
            hasIncludeFunctionTwin,
            getPreferredFunctionHoverMatch,
            getDeclMatchKey,
            resolveArgumentSymbolName,
            applyHoverDisplayNameSuffixToMatches,
            createHoverRangeFromOffsets
        });
        const callHoverPlan = resolveSemanticCallHoverPlan({
            shouldShowArgHoverInfo,
            definitionCtx,
            nestedFunctionArgCtx,
            activeSignatureCtx,
            signatureData,
            signatureArgLayout,
            targetFunc,
            argIndex,
            callSiteArgs,
            documentSemanticKey,
            word,
            wordAccessSuffix,
            indexedAccessHoverCtx,
            tokenRange
        });
        const {
            argHoverMatches,
            effectiveArgIndex,
            validateSignatureArgs,
            forceColoredSignature,
            semanticCallHoverCacheKey,
            semanticHoverRange
        } = callHoverPlan;
        const cachedSemanticCallHover = getSemanticHoverCacheEntry(semanticCallHoverCacheKey);
        if (cachedSemanticCallHover) {
            return cachedSemanticCallHover;
        }

        return setSemanticHoverCacheEntry(
            semanticCallHoverCacheKey,
            new vscode.Hover(
                buildHoverMarkdown(
                    matches,
                    effectiveArgIndex,
                    callSiteArgs,
                    allDecls,
                    buildArgHoverInfo(argHoverMatches, fp, effectiveArgIndex == null, {
                        allDecls,
                        lookup,
                        variableAccessBaseName: indexedAccessHoverCtx?.baseName || '',
                        variableAccessSuffix: indexedAccessHoverCtx?.suffix || '',
                        variableAccessActiveIndex: indexedAccessHoverCtx?.activeAccessIndex ?? null
                    }),
                    fp,
                    bitmaskCtx,
                    funcArgs,
                    locals,
                    globals,
                    functions,
                    incDecls,
                    !matches.length ? bitmaskPartCtx : null,
                    {
                        validateSignatureArgs,
                        forceColoredSignature,
                        variableAccessSuffix: wordAccessSuffix,
                        variableAccessActiveIndex: wordAccessActiveIndex,
                        hoveredWord: word,
                        signatureArgLayout,
                        lookup
                    }
                ),
                semanticHoverRange || undefined
            )
        );
    }

    return {
        buildHoverAtPosition
    };
}

module.exports = { createHoverBuilderFeature };
