function touchLimitedMap(map, key, value, limit = 256) {
    if (!map || !key) return value;
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) {
        const oldestKey = map.keys().next().value;
        map.delete(oldestKey);
    }
    return value;
}

function getSemanticSessionMap(semanticSession, name) {
    if (!semanticSession || !name) return null;
    let map = semanticSession[name];
    if (!(map instanceof Map)) {
        map = new Map();
        semanticSession[name] = map;
    }
    return map;
}

function getSemanticSignatureCache(semanticSession, cacheName, signature, createCache, limit = 8) {
    if (!semanticSession || !cacheName || !signature) return null;
    const bySignature = getSemanticSessionMap(semanticSession, cacheName);
    if (!bySignature) return null;
    let cache = bySignature.get(signature);
    if (!cache) {
        cache = typeof createCache === 'function' ? createCache() : new Map();
        bySignature.set(signature, cache);
        while (bySignature.size > limit) {
            const oldestKey = bySignature.keys().next().value;
            bySignature.delete(oldestKey);
        }
    }
    return cache;
}

function getSemanticParsedDeclsMap(semanticSession, cacheName, parsedDecls, createCache = () => new Map()) {
    if (!semanticSession || !cacheName || !parsedDecls) return null;
    const byParsedDecls = getSemanticSessionMap(semanticSession, cacheName);
    if (!byParsedDecls) return null;
    let cache = byParsedDecls.get(parsedDecls);
    if (!cache) {
        cache = createCache();
        byParsedDecls.set(parsedDecls, cache);
    }
    return cache;
}

function getSemanticAnalysisCache(semanticSession, parsedDecls, lookup, createAnalysisCache) {
    if (!semanticSession || !parsedDecls) {
        return typeof createAnalysisCache === 'function'
            ? createAnalysisCache([], lookup)
            : null;
    }
    if (!(semanticSession.analysisCacheByParsedDecls instanceof WeakMap)) {
        semanticSession.analysisCacheByParsedDecls = new WeakMap();
    }
    const cachedAnalysis = semanticSession.analysisCacheByParsedDecls.get(parsedDecls);
    if (cachedAnalysis) return cachedAnalysis;
    const analysisCache = typeof createAnalysisCache === 'function'
        ? createAnalysisCache([], lookup)
        : null;
    if (analysisCache) {
        semanticSession.analysisCacheByParsedDecls.set(parsedDecls, analysisCache);
    }
    return analysisCache;
}

module.exports = {
    touchLimitedMap,
    getSemanticSessionMap,
    getSemanticSignatureCache,
    getSemanticParsedDeclsMap,
    getSemanticAnalysisCache
};
