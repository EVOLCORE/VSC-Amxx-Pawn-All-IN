function createCallArgLayoutCore(deps) {
    const {
        parseParamMeta,
        isVariadicParam,
        getActiveCtrlChar,
        splitTopLevel,
        splitTopLevelWithRanges
    } = deps;
    const staticCallArgLayoutCache = new Map();
    const staticCallArgLayoutArrayCache = new WeakMap();
    const staticCallArgParamsKeyCache = new WeakMap();
    const dynamicCallArgLayoutCache = new Map();
    const objectLikeDefineTupleArgsCacheByLookup = new WeakMap();
    const DYNAMIC_CALL_ARG_LAYOUT_CACHE_LIMIT = 512;

    function getStaticCallArgLayout(paramsOrArgsText) {
        if (Array.isArray(paramsOrArgsText)) {
            const params = paramsOrArgsText;
            const cached = staticCallArgLayoutArrayCache.get(params);
            if (cached) return cached;
            const paramMetas = params.map(parseParamMeta);
            const paramIndexByName = new Map();
            paramMetas.forEach((meta, index) => {
                if (!meta.name || paramIndexByName.has(meta.name)) return;
                paramIndexByName.set(meta.name, index);
            });
            const variadicIndex = paramMetas.length > 0 && isVariadicParam(params[paramMetas.length - 1])
                ? paramMetas.length - 1
                : -1;
            const layout = {
                params,
                paramMetas,
                paramIndexByName,
                variadicIndex
            };
            staticCallArgLayoutArrayCache.set(params, layout);
            return layout;
        }

        const argsText = String(paramsOrArgsText || '');
        const cacheKey = `${getActiveCtrlChar()}\u0000${argsText}`;
        const cached = staticCallArgLayoutCache.get(cacheKey);
        if (cached) return cached;

        const params = splitTopLevel(argsText);
        const paramMetas = params.map(parseParamMeta);
        const paramIndexByName = new Map();
        paramMetas.forEach((meta, index) => {
            if (!meta.name || paramIndexByName.has(meta.name)) return;
            paramIndexByName.set(meta.name, index);
        });
        const variadicIndex = paramMetas.length > 0 && isVariadicParam(params[paramMetas.length - 1])
            ? paramMetas.length - 1
            : -1;
        const layout = {
            params,
            paramMetas,
            paramIndexByName,
            variadicIndex
        };
        staticCallArgLayoutCache.set(cacheKey, layout);
        return layout;
    }

    function buildCallArgLayout(paramsOrArgsText, rawCallSiteArgs, rawCurrentArgIndex = null, options = {}) {
        const useDynamicCache = options.useDynamicCache !== false;
        let dynamicCacheKey = '';
        if (useDynamicCache) {
            let paramsKey = '';
            if (Array.isArray(paramsOrArgsText)) {
                if (staticCallArgParamsKeyCache.has(paramsOrArgsText)) {
                    paramsKey = staticCallArgParamsKeyCache.get(paramsOrArgsText);
                } else {
                    paramsKey = paramsOrArgsText.map(item => String(item ?? '')).join('\u0002');
                    staticCallArgParamsKeyCache.set(paramsOrArgsText, paramsKey);
                }
            } else {
                paramsKey = String(paramsOrArgsText || '');
            }
            const callArgsKey = Array.isArray(rawCallSiteArgs)
                ? rawCallSiteArgs.map(item => String(item ?? '')).join('\u0001')
                : '';
            dynamicCacheKey = [
                getActiveCtrlChar(),
                paramsKey,
                rawCurrentArgIndex ?? -1,
                callArgsKey
            ].join('\u0000');
            const cachedDynamicLayout = dynamicCallArgLayoutCache.get(dynamicCacheKey);
            if (cachedDynamicLayout) {
                dynamicCallArgLayoutCache.delete(dynamicCacheKey);
                dynamicCallArgLayoutCache.set(dynamicCacheKey, cachedDynamicLayout);
                return cachedDynamicLayout;
            }
        }

        const {
            params,
            paramMetas,
            paramIndexByName,
            variadicIndex
        } = getStaticCallArgLayout(paramsOrArgsText);
        const effectiveArgs = new Array(paramMetas.length).fill(undefined);
        const variadicArgs = [];
        const rawToParamIndex = [];
        const extraArgs = [];
        const namedArgIssues = [];
        let nextPositionalIndex = 0;
        let sawNamedArgument = false;

        const consumePositionalIndex = () => {
            while (
                nextPositionalIndex < paramMetas.length &&
                effectiveArgs[nextPositionalIndex] !== undefined &&
                !(variadicIndex >= 0 && nextPositionalIndex === variadicIndex)
            ) {
                nextPositionalIndex++;
            }
            return nextPositionalIndex;
        };

        for (let rawIndex = 0; rawIndex < (rawCallSiteArgs?.length || 0); rawIndex++) {
            const originalExpr = rawCallSiteArgs[rawIndex] ?? '';
            const trimmedExpr = String(originalExpr).trim();
            const namedArg = trimmedExpr.match(/^\.\s*([A-Za-z_@][A-Za-z0-9_@]*)\s*=\s*([\s\S]*)$/);

            if (namedArg) {
                sawNamedArgument = true;
                const paramIndex = paramIndexByName.get(namedArg[1]) ?? -1;
                const actualExpr = namedArg[2].trim();
                if (paramIndex < 0) {
                    namedArgIssues.push({
                        kind: 'unknownNamedArgument',
                        rawIndex,
                        name: namedArg[1],
                        argText: trimmedExpr
                    });
                    continue;
                }
                const targetParamIndex = variadicIndex >= 0 && paramIndex >= variadicIndex
                    ? variadicIndex
                    : paramIndex;
                if (
                    (targetParamIndex === variadicIndex && variadicArgs.length > 0) ||
                    (targetParamIndex !== variadicIndex && effectiveArgs[targetParamIndex] !== undefined)
                ) {
                    namedArgIssues.push({
                        kind: 'duplicateNamedArgument',
                        rawIndex,
                        name: namedArg[1],
                        argText: trimmedExpr
                    });
                }
                rawToParamIndex[rawIndex] = targetParamIndex;
                if (variadicIndex >= 0 && paramIndex === variadicIndex) {
                    variadicArgs.push(actualExpr);
                } else {
                    effectiveArgs[paramIndex] = actualExpr;
                }
                continue;
            }

            if (sawNamedArgument) {
                namedArgIssues.push({
                    kind: 'positionalAfterNamedArgument',
                    rawIndex,
                    argText: trimmedExpr
                });
            }
            const positionalIndex = consumePositionalIndex();
            if (variadicIndex >= 0 && positionalIndex >= variadicIndex) {
                rawToParamIndex[rawIndex] = variadicIndex;
                variadicArgs.push(trimmedExpr);
                continue;
            }
            if (positionalIndex >= paramMetas.length) {
                extraArgs.push(trimmedExpr || `arg${rawIndex}`);
                continue;
            }

            rawToParamIndex[rawIndex] = positionalIndex;
            effectiveArgs[positionalIndex] = trimmedExpr;
            nextPositionalIndex = positionalIndex + 1;
        }

        const currentParamIndex = rawCurrentArgIndex == null
            ? null
            : (rawToParamIndex[rawCurrentArgIndex] ?? null);
        const currentRawArgExpr = rawCurrentArgIndex == null
            ? null
            : String(rawCallSiteArgs?.[rawCurrentArgIndex] ?? '').trim();
        const currentArgExpr = currentParamIndex == null
            ? null
            : (currentParamIndex === variadicIndex
                ? (variadicArgs[0] ?? '')
                : (effectiveArgs[currentParamIndex] ?? ''));

        const layout = {
            params,
            paramMetas,
            variadicIndex,
            effectiveArgs,
            variadicArgs,
            extraArgs,
            namedArgIssues,
            rawToParamIndex,
            currentParamIndex,
            currentRawArgExpr,
            currentArgExpr
        };
        if (useDynamicCache) {
            dynamicCallArgLayoutCache.set(dynamicCacheKey, layout);
            while (dynamicCallArgLayoutCache.size > DYNAMIC_CALL_ARG_LAYOUT_CACHE_LIMIT) {
                const oldestKey = dynamicCallArgLayoutCache.keys().next().value;
                dynamicCallArgLayoutCache.delete(oldestKey);
            }
        }
        return layout;
    }

    function getObjectLikeDefineTupleTexts(bareName, lookup, escapeChar = '') {
        if (!bareName || !lookup?.findAnyDeclByName) return null;
        let defineTupleCache = objectLikeDefineTupleArgsCacheByLookup.get(lookup);
        if (!defineTupleCache) {
            defineTupleCache = new Map();
            objectLikeDefineTupleArgsCacheByLookup.set(lookup, defineTupleCache);
        }
        const cacheKey = `${escapeChar || ''}\u0000${bareName}`;
        if (defineTupleCache.has(cacheKey)) {
            return defineTupleCache.get(cacheKey);
        }

        const defineDecl = lookup.findAnyDeclByName(
            bareName,
            item => item.type === 'define' && !item.args
        );
        const defineValue = String(defineDecl?.value || '').trim();
        let tupleTexts = null;
        if (defineValue && defineValue.includes(',')) {
            const tupleParts = splitTopLevelWithRanges(defineValue, 0, escapeChar);
            tupleTexts = tupleParts.length > 1 && !tupleParts.some(item => !String(item?.text || '').trim())
                ? tupleParts.map(item => item.text)
                : null;
        }
        defineTupleCache.set(cacheKey, tupleTexts);
        return tupleTexts;
    }

    function expandObjectLikeDefineTupleCallArgs(callArgs, lookup, escapeChar = '') {
        if (!Array.isArray(callArgs) || !callArgs.length) return callArgs;

        let expanded = null;
        for (let index = 0; index < callArgs.length; index++) {
            const rawArg = String(callArgs[index] || '');
            const bareName = rawArg.trim().match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
            const tupleTexts = bareName
                ? getObjectLikeDefineTupleTexts(bareName, lookup, escapeChar)
                : null;
            if (!tupleTexts?.length) {
                if (expanded) expanded.push(rawArg);
                continue;
            }
            if (!expanded) expanded = callArgs.slice(0, index).map(item => String(item || ''));
            expanded.push(...tupleTexts);
        }

        return expanded || callArgs;
    }

    function expandObjectLikeDefineTupleArgPieces(rawArgPieces, lookup, escapeChar = '') {
        const expandedPieces = [];
        const rawIndexMap = [];

        for (let rawIndex = 0; rawIndex < (rawArgPieces?.length || 0); rawIndex++) {
            const rawArgPiece = rawArgPieces[rawIndex];
            const rawText = String(rawArgPiece?.text || '');
            const bareName = rawText.trim().match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
            const tupleTexts = bareName
                ? getObjectLikeDefineTupleTexts(bareName, lookup, escapeChar)
                : null;
            if (!tupleTexts?.length) {
                expandedPieces.push(rawArgPiece);
                rawIndexMap.push(rawIndex);
                continue;
            }

            for (const tupleText of tupleTexts) {
                expandedPieces.push({
                    text: tupleText,
                    startOffset: rawArgPiece.startOffset,
                    endOffset: rawArgPiece.endOffset
                });
                rawIndexMap.push(rawIndex);
            }
        }

        return { expandedPieces, rawIndexMap };
    }

    function hasExpandableObjectLikeDefineTupleArg(rawArgPieces, lookup, escapeChar = '') {
        for (const rawArgPiece of rawArgPieces || []) {
            const bareName = String(rawArgPiece?.text || '').trim().match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
            if (!bareName) continue;
            const tupleTexts = getObjectLikeDefineTupleTexts(bareName, lookup, escapeChar);
            if (tupleTexts?.length) return true;
        }
        return false;
    }

    return {
        buildCallArgLayout,
        expandObjectLikeDefineTupleArgPieces,
        expandObjectLikeDefineTupleCallArgs,
        getObjectLikeDefineTupleTexts,
        hasExpandableObjectLikeDefineTupleArg
    };
}

module.exports = { createCallArgLayoutCore };
