const {
    touchLimitedMap
} = require('../../core/document-context/semantic-session');

function createHoverSemanticCache(options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 128;
    const semanticHoverCache = new Map();
    const semanticSessionIds = new WeakMap();
    let nextSemanticSessionId = 1;

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

    function getDocumentSemanticKey(document, semanticSession = null, cacheSignature = '') {
        const uri = document?.uri?.toString?.() || document?.fileName || '';
        const version = Number.isInteger(document?.version) ? document.version : 0;
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
        return touchLimitedMap(semanticHoverCache, key, hover, limit);
    }

    return {
        getDocumentSemanticKey,
        getSemanticHoverCacheEntry,
        setSemanticHoverCacheEntry
    };
}

module.exports = { createHoverSemanticCache };
