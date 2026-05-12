function createTypeAnalysisCacheFactory(deps) {
    const {
        BUILTIN_DECLS,
        findDeclByNameCached,
        parseDimSpec,
        parseDimsParts,
        parseParamMeta
    } = deps;

    const hoverTypeAnalysisCacheProto = {
        findDeclByName(name, predicate = null) {
            if (this.lookup?.findAnyLocalDeclByName) {
                return this.lookup.findAnyLocalDeclByName(name, predicate);
            }
            const matches = this.declsByName?.get(name);
            if (!matches?.length) return null;
            if (!predicate) return matches[0];
            for (const decl of matches) {
                if (predicate(decl)) return decl;
            }
            return null;
        },
        findAnyDeclByName(name, predicate = null) {
            if (this.lookup?.findAnyDeclByName) {
                return this.lookup.findAnyDeclByName(name, predicate);
            }
            const localDecl = this.findDeclByName(name, predicate);
            if (localDecl) return localDecl;
            return findDeclByNameCached(BUILTIN_DECLS, name, predicate);
        },
        getParamMeta(paramText) {
            const key = String(paramText || '');
            if (!this.paramMetaByText.has(key)) {
                this.paramMetaByText.set(key, parseParamMeta(key));
            }
            return this.paramMetaByText.get(key);
        },
        getDimParts(dimText) {
            const key = String(dimText || '');
            if (!this.dimPartsByText.has(key)) {
                this.dimPartsByText.set(key, parseDimsParts(key));
            }
            return this.dimPartsByText.get(key);
        },
        getDimSpec(dimText) {
            const key = String(dimText || '');
            if (!this.dimSpecByText.has(key)) {
                this.dimSpecByText.set(key, parseDimSpec(key, this.sourceDecls, new Set(), this));
            }
            return this.dimSpecByText.get(key);
        }
    };

    return function createHoverTypeAnalysisCache(allDecls = [], lookup = null) {
        const sourceDecls = Array.isArray(allDecls) ? allDecls : [];
        const cache = Object.create(hoverTypeAnalysisCacheProto);
        cache.sourceDecls = sourceDecls;
        cache.lookup = lookup || null;
        cache.declsByName = lookup?.findAnyLocalDeclByName ? null : (() => {
            const buckets = new Map();
            for (const decl of sourceDecls) {
                if (!decl?.name) continue;
                if (!buckets.has(decl.name)) buckets.set(decl.name, []);
                buckets.get(decl.name).push(decl);
            }
            return buckets;
        })();
        cache.argTypeByExpr = new Map();
        cache.inferInProgressByExpr = new Set();
        cache.unresolvedRefsByExpr = new Map();
        cache.paramMetaByText = new Map();
        cache.dimPartsByText = new Map();
        cache.dimSpecByText = new Map();
        cache.callReturnTypeByExpr = new Map();
        cache.numericExprByText = new Map();
        cache.indexedDimCompatByKey = new Map();
        cache.typeCompatByKey = new Map();
        return cache;
    };
}

function getTypeAnalysisSourceDecls(ctx, analysisCache, fallbackCtx = null) {
    if (analysisCache) return [];
    if (Array.isArray(ctx?.allDecls)) return ctx.allDecls;
    if (Array.isArray(fallbackCtx?.allDecls)) return fallbackCtx.allDecls;
    return [];
}

module.exports = {
    createTypeAnalysisCacheFactory,
    getTypeAnalysisSourceDecls
};
