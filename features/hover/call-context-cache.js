const {
    touchLimitedMap,
    getSemanticSessionMap
} = require('../../core/document-context/semantic-session');

function createHoverCallContextCache({
    semanticSession,
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
}) {
    const getPositionCacheKey = hoverPosition =>
        `${documentSemanticKey}|${hoverPosition?.line ?? -1}:${hoverPosition?.character ?? -1}`;

    const findPreferredKnownCallContextCached = hoverPosition => {
        const cache = getSemanticSessionMap(semanticSession || null, 'hoverPreferredKnownCallContextByPosition');
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
        const cache = getSemanticSessionMap(semanticSession || null, 'hoverNestedParentCallNameContextByPosition');
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
        const cache = getSemanticSessionMap(semanticSession || null, 'hoverFunctionCallNameContextByPosition');
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
        const cache = getSemanticSessionMap(semanticSession || null, 'hoverCallSiteArgsByOpenOffset');
        const key = `${documentSemanticKey}|call-site-args|${boundedOpenOffset}`;
        if (cache?.has(key)) return cache.get(key);
        const value = extractCallSiteArgs(text, boundedOpenOffset);
        return cache ? touchLimitedMap(cache, key, value, 512) : value;
    };

    const buildCallArgLayoutCached = (signatureArgs, rawCallSiteArgs, currentArgIndex = null) => {
        const cache = getSemanticSessionMap(semanticSession || null, 'hoverCallArgLayoutBySignature');
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

    return {
        buildCallArgLayoutCached,
        extractCallSiteArgsCached,
        findFunctionCallNameContextCached,
        findNestedParentCallNameContextCached,
        findPreferredKnownCallContextCached
    };
}

module.exports = { createHoverCallContextCache };
