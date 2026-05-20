const { createHoverAccessHoverFeature } = require('./access-hover');
const { createHoverCallPlanFeature } = require('./call-plan');
const { createHoverCallContextCache } = require('./call-context-cache');
const { createHoverSessionFactory } = require('./session');
const { createHoverSemanticCache } = require('./semantic-cache');
const {
    dedupeHoverMatches,
    hasHoverMatch
} = require('./match-dedupe');
const { isInactivePreprocessorMaskedLine } = require('../../core/syntax/preprocessor-lines');
const { findFormatPlaceholderLinkAtOffset } = require('../../core/format-strings');

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
        buildHoverMarkdown: buildRawHoverMarkdown,
        buildArgHoverInfo: buildRawArgHoverInfo,
        findDefinitionContext,
        findPreferredKnownCallContext,
        isNearbyCallContext,
        isHoverAtActiveCursor,
        findNestedParentCallNameContext,
        findFunctionCallNameContext,
        findCallContext,
        findMatchingParenOffset,
        getPreferredFunctionHoverMatch,
        extractCallSiteArgs,
        hasIncludeFunctionTwin,
        splitTopLevel,
        splitTopLevelWithRanges,
        isEscapedQuote,
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
        shouldSuppressHoverValidationForDocument = () => false,
        getHoverCacheSignature,
        logHover = null
    } = deps;
    const { createHoverSession } = createHoverSessionFactory({
        t,
        getPawnDocumentContext,
        collectIndexedAccessExpressionsFromLine,
        findIndexedAccessContextAtPosition,
        getCtrlCharStateForContent,
        createHoverTypeAnalysisCache
    });
    const {
        getDocumentSemanticKey,
        getSemanticHoverCacheEntry,
        setSemanticHoverCacheEntry
    } = createHoverSemanticCache({ limit: 128 });

    function buildHoverAtPosition(document, position) {
        const startedAt = Date.now();
        const fileName = String(document?.fileName || '');
        const line = Number.isInteger(position?.line) ? position.line : -1;
        const character = Number.isInteger(position?.character) ? position.character : -1;
        try {
            logHover?.(`start file=${fileName} pos=${line}:${character} version=${document?.version ?? ''}`);
        } catch {
            // Debug logging must not affect hover.
        }
        try {
        const createHoverRangeFromOffsets = (startOffset, endOffset) => {
            if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset < startOffset) {
                return null;
            }
            return new vscode.Range(
                document.positionAt(startOffset),
                document.positionAt(Math.max(startOffset + 1, endOffset))
            );
        };
        let suppressHoverValidation = false;
        const buildHoverMarkdown = (...args) => {
            if (!suppressHoverValidation) return buildRawHoverMarkdown(...args);
            const optionsIndex = 13;
            const options = args[optionsIndex] || {};
            args[optionsIndex] = { ...options, suppressValidation: true };
            return buildRawHoverMarkdown(...args);
        };
        const buildArgHoverInfo = (matches, currentFilePath = '', includeDocs = true, options = {}) =>
            buildRawArgHoverInfo(
                matches,
                currentFilePath,
                includeDocs,
                suppressHoverValidation
                    ? { ...options, validateVariableAccess: false }
                    : options
            );
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
        try {
            logHover?.(`context-ready file=${fileName} pos=${line}:${character} ms=${Date.now() - startedAt}`);
        } catch {
            // Debug logging must not affect hover.
        }
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
        suppressHoverValidation = shouldSuppressHoverValidationForDocument(document) ||
            isInactivePreprocessorMaskedLine(
                ctx.rawLines,
                ctx.preprocessedState?.rawLines,
                position.line
            );
        const documentSemanticKey = getDocumentSemanticKey(
            document,
            ctx.semanticSession || null,
            getHoverCacheSignature()
        );
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
        const isSamePosition = (left, right) =>
            !!left &&
            !!right &&
            left.line === right.line &&
            left.character === right.character;
        const {
            buildCallArgLayoutCached,
            extractCallSiteArgsCached,
            findFunctionCallNameContextCached,
            findNestedParentCallNameContextCached,
            findPreferredKnownCallContextCached
        } = createHoverCallContextCache({
            semanticSession: ctx.semanticSession || null,
            document,
            documentSemanticKey,
            functions,
            incDecls,
            lookup,
            callContextOptions,
            text,
            findPreferredKnownCallContext,
            findNestedParentCallNameContext,
            findFunctionCallNameContext,
            extractCallSiteArgs,
            buildCallArgLayout
        });
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
            const unique = dedupeHoverMatches(matchList, getDeclMatchKey);
            return buildArgHoverInfo(unique, fp, includeDocs, options);
        };
        const buildFormatPlaceholderHover = () => {
            if (!lineText.includes('%')) return null;
            if (typeof findCallContext !== 'function') return null;
            const callCtx = findCallContext(document, position, callContextOptions);
            if (!callCtx?.funcName) return null;
            const link = findFormatPlaceholderLinkAtOffset(text, callCtx, positionOffset, {
                splitTopLevelWithRanges,
                findMatchingParenOffset,
                ctrlCharResolver: resolver,
                isEscapedQuote,
                escapeChar: resolver.ctrlCharAtLine?.(position.line) || ''
            });
            if (!link) return null;

            const md = new vscode.MarkdownString();
            const argsText = (link.args || [])
                .map(arg => String(arg.text || '').trim())
                .filter(Boolean)
                .join(', ');
            md.appendMarkdown('**Format placeholder**\n\n');
            const code = `${link.placeholder.raw} -> ${argsText || '<missing argument>'}`;
            if (typeof md.appendCodeblock === 'function') {
                md.appendCodeblock(code, 'pawn');
            } else {
                md.appendMarkdown(`\`\`\`pawn\n${code}\n\`\`\``);
            }
            if (link.placeholder.consumes > 1) {
                md.appendMarkdown(`\n\nConsumes arguments: ${link.placeholder.consumes}`);
            }
            if (link.callName) {
                md.appendMarkdown(`\n\nCall: \`${link.callName}\``);
            }
            const hoverRange = createHoverRangeFromOffsets(
                link.placeholder.startOffset,
                link.placeholder.endOffset
            );
            return new vscode.Hover(md, hoverRange || undefined);
        };
        const formatPlaceholderHover = buildFormatPlaceholderHover();
        if (formatPlaceholderHover) return formatPlaceholderHover;
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
            findFunctionCallNameContextCached(position, null);
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
        let activeCallSignatureHoverData = undefined;
        const getActiveCallSignatureHoverData = () => {
            if (activeCallSignatureHoverData !== undefined) return activeCallSignatureHoverData;
            activeCallSignatureHoverData = null;
            const activeSignatureCtx = nestedSignatureCtx || displayCallCtx;
            if (!shouldShowCallSignatureHover || !activeSignatureCtx?.funcName) return activeCallSignatureHoverData;
            const match = getPreferredFunctionHoverMatch(
                activeSignatureCtx.funcName,
                functions,
                incDecls,
                { preferInclude: hasIncludeFunctionTwin(activeSignatureCtx.funcName, incDecls, lookup) },
                lookup
            );
            if (!match) return activeCallSignatureHoverData;
            activeCallSignatureHoverData = {
                match,
                argIndex: activeSignatureCtx.argIndex,
                callSiteArgs: extractCallSiteArgsCached(activeSignatureCtx.openOffset)
            };
            return activeCallSignatureHoverData;
        };

        const { resolveIndexedAccessHover } = createHoverAccessHoverFeature({
            vscode,
            buildHoverMarkdown,
            buildArgHoverInfo,
            buildDistinctArgHoverInfo,
            buildIndexedAccessSelectionModel,
            createHoverRangeFromOffsets,
            getActiveCallSignatureHoverData,
            getDeclMatchKey,
            getLocalFirstWordMatches,
            getVariableWordMatches,
            parseDimsParts,
            resolveArgumentSymbolName,
            resolver,
            position,
            lineStartOffset,
            tokenRange,
            fp,
            allDecls,
            bitmaskCtx,
            bitmaskPartCtx,
            funcArgs,
            locals,
            globals,
            functions,
            incDecls,
            lookup
        });
        const indexedAccessHover = resolveIndexedAccessHover({
            taggedIndexedAccessCtx: findTaggedIndexedAccessContextAtPosition(position),
            indexedAccessContext,
            indexedAccessHoverCtx,
            word
        });
        if (indexedAccessHover) return indexedAccessHover;

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
                !hasHoverMatch(matches, preferredCallMatch, getDeclMatchKey)
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
        } finally {
            try {
                logHover?.(`done file=${fileName} pos=${line}:${character} ms=${Date.now() - startedAt}`);
            } catch {
                // Debug logging must not affect hover.
            }
        }
    }

    return {
        buildHoverAtPosition
    };
}

module.exports = { createHoverBuilderFeature };
