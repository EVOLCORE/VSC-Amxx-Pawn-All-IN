const {
    findFormatPlaceholderLinkAtOffset,
    getCallArgumentPieces
} = require('../../core/format-strings');

function getTextAndResolver(deps, document) {
    return typeof deps.getDocumentTextAndResolver === 'function'
        ? deps.getDocumentTextAndResolver(document)
        : { text: String(document?.getText?.() || ''), resolver: null };
}

function getMacroArgNames(defineDecl, splitTopLevelWithRanges) {
    const source = String(defineDecl?.macroStyle === 'bracket'
        ? defineDecl?.macroIndexer
        : defineDecl?.args || ''
    ).trim();
    if (!source) return [];

    const placeholderNames = [...source.matchAll(/%\d+/g)]
        .map(match => match[0])
        .filter((name, index, names) => names.indexOf(name) === index);
    if (placeholderNames.length) return placeholderNames;

    if (typeof splitTopLevelWithRanges === 'function') {
        return splitTopLevelWithRanges(source, 0, '', true)
            .map(part => String(part?.text || '').trim())
            .filter(Boolean);
    }

    return source.split(',')
        .map(part => part.trim())
        .filter(Boolean);
}

function getSingleMacroArgReference(source, macroArgIndexByName) {
    const text = String(source || '').trim();
    if (!text || !macroArgIndexByName?.has(text)) return null;
    return {
        name: text,
        index: macroArgIndexByName.get(text)
    };
}

function getMatchingParenAdapter(findMatchingParenOffset) {
    if (typeof findMatchingParenOffset !== 'function') return null;
    return (source, openOffset, maxOffset, ctrlCharResolver, options = {}) =>
        findMatchingParenOffset(source, openOffset, maxOffset, ctrlCharResolver, options);
}

function createFormatPlaceholderResolver(deps) {
    const {
        getPawnDocumentContext,
        findCallContext,
        findMatchingParenOffset,
        splitTopLevelWithRanges,
        isEscapedQuote,
        getPreferredFunctionHoverMatch = null,
        buildCallArgLayout = null,
        createLazyCallContextOptions = null,
        isFunctionLikeDefineDecl = null,
        collectInlineNamedCallContexts = null
    } = deps;

    function getSignatureLayout(callName, ctx) {
        if (!callName || typeof getPreferredFunctionHoverMatch !== 'function' || typeof buildCallArgLayout !== 'function') {
            return null;
        }
        const signatureMatch = getPreferredFunctionHoverMatch(
            callName,
            ctx?.parsedDecls?.functions || [],
            ctx?.incDecls || [],
            {},
            ctx?.lookup || null
        );
        if (!signatureMatch?.data) return null;
        const layout = buildCallArgLayout(signatureMatch.data.args || '', [], null, { useDynamicCache: false });
        return layout
            ? {
                data: signatureMatch.data,
                layout
            }
            : null;
    }

    function findFunctionLikeDefineDecl(ctx, callName, signatureData = null) {
        if (!callName) return null;
        if (typeof isFunctionLikeDefineDecl === 'function' && isFunctionLikeDefineDecl(signatureData)) {
            return signatureData;
        }

        const allDecls = [
            ...(ctx?.preprocessedState?.defineDecls || []),
            ...(ctx?.parsedDecls?.functions || []),
            ...(ctx?.incDecls || [])
        ];
        return allDecls.find(decl =>
            decl?.name === callName &&
            (typeof isFunctionLikeDefineDecl === 'function'
                ? isFunctionLikeDefineDecl(decl)
                : (decl.type === 'define' && decl.macroStyle === 'paren'))
        ) || null;
    }

    function getDefineForwardedFormatArgIndexes(defineDecl, ctx) {
        if (!defineDecl || typeof collectInlineNamedCallContexts !== 'function') return null;
        const value = String(defineDecl.value || '').trim();
        if (!value || value.indexOf('%') < 0 || value.indexOf('(') < 0) return null;

        const macroArgNames = getMacroArgNames(defineDecl, splitTopLevelWithRanges);
        if (!macroArgNames.length) return null;
        const macroArgIndexByName = new Map();
        for (let index = 0; index < macroArgNames.length; index++) {
            if (!macroArgIndexByName.has(macroArgNames[index])) {
                macroArgIndexByName.set(macroArgNames[index], index);
            }
        }

        const calls = collectInlineNamedCallContexts(value, 0, '', { includeClosedCalls: true }) || [];
        if (!calls.length) return null;

        const allowed = new Set();
        const targetCalls = new Set();
        const findMatchingParen = getMatchingParenAdapter(findMatchingParenOffset);
        for (const nestedCallCtx of calls) {
            if (!nestedCallCtx?.funcName || nestedCallCtx.funcName === defineDecl.name) continue;
            const signature = getSignatureLayout(nestedCallCtx.funcName, ctx);
            const variadicIndex = signature?.layout?.variadicIndex ?? -1;
            if (variadicIndex < 0) continue;

            const nestedArgs = getCallArgumentPieces(value, nestedCallCtx, {
                splitTopLevelWithRanges,
                findMatchingParenOffset: findMatchingParen,
                isEscapedQuote
            });
            if (!nestedArgs.length) continue;

            for (let argIndex = 0; argIndex < nestedArgs.length; argIndex++) {
                if (argIndex >= variadicIndex) continue;
                const macroArg = getSingleMacroArgReference(nestedArgs[argIndex]?.text, macroArgIndexByName);
                if (!macroArg) continue;
                const forwardedFormatArgCount = variadicIndex - argIndex;
                for (let offset = 0; offset < forwardedFormatArgCount; offset++) {
                    allowed.add(macroArg.index + offset);
                }
                targetCalls.add(nestedCallCtx.funcName);
            }
        }

        return allowed.size
            ? { allowedFormatArgIndexes: allowed, targetCalls }
            : null;
    }

    function findPlaceholderLink(document, position) {
        const lineText = String(document?.lineAt?.(position.line)?.text || '');
        if (!lineText.includes('%')) return null;
        if (typeof findCallContext !== 'function') return null;

        const ctx = typeof getPawnDocumentContext === 'function'
            ? getPawnDocumentContext(document, position.line)
            : null;
        const { text, resolver } = getTextAndResolver(deps, document);
        const callContextOptions = typeof createLazyCallContextOptions === 'function'
            ? createLazyCallContextOptions(document, ctx?.semanticSession || null)
            : {};
        const callCtx = findCallContext(document, position, callContextOptions);
        if (!callCtx?.funcName) return null;

        const offset = document.offsetAt(position);
        const escapeChar = resolver?.ctrlCharAtLine?.(position.line) || '';
        const baseLinkOptions = {
            splitTopLevelWithRanges,
            findMatchingParenOffset,
            ctrlCharResolver: resolver,
            isEscapedQuote,
            escapeChar
        };
        const signature = getSignatureLayout(callCtx.funcName, ctx);
        if (signature?.layout?.variadicIndex >= 0) {
            const link = findFormatPlaceholderLinkAtOffset(text, callCtx, offset, {
                ...baseLinkOptions,
                maxFormatArgIndexExclusive: signature.layout.variadicIndex
            });
            if (link) return link;
        }

        const defineDecl = findFunctionLikeDefineDecl(ctx, callCtx.funcName, signature?.data || null);
        const macroPlan = getDefineForwardedFormatArgIndexes(defineDecl, ctx);
        if (!macroPlan?.allowedFormatArgIndexes?.size) return null;

        return findFormatPlaceholderLinkAtOffset(text, callCtx, offset, {
            ...baseLinkOptions,
            allowedFormatArgIndexes: macroPlan.allowedFormatArgIndexes,
            callName: macroPlan.targetCalls?.size
                ? `${callCtx.funcName} -> ${[...macroPlan.targetCalls].join(', ')}`
                : callCtx.funcName
        });
    }

    return {
        findPlaceholderLink
    };
}

module.exports = { createFormatPlaceholderResolver };
