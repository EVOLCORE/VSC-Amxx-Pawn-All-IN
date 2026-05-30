function createTypeAnalysisCacheFactory(deps) {
    const {
        BUILTIN_DECLS,
        findDeclByNameCached,
        getDeclNameBuckets,
        parseDimSpec,
        parseDimsParts,
        parseParamMeta
    } = deps;
    const isVariableDecl = decl => decl?.type === 'variable';

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
        findVariableByName(name) {
            if (this.lookup?.findDocumentVariable) {
                const documentVariable = this.lookup.findDocumentVariable(name);
                if (documentVariable) return documentVariable;
            }
            return this.findAnyDeclByName(name, isVariableDecl);
        },
        findDefineByName(name) {
            if (this.lookup?.findDefine) {
                return this.lookup.findDefine(name);
            }
            if (!this.defineDeclByName) {
                this.defineDeclByName = new Map();
                const appendDecls = decls => {
                    for (const decl of decls || []) {
                        if (decl?.type !== 'define' || !decl.name || this.defineDeclByName.has(decl.name)) continue;
                        this.defineDeclByName.set(decl.name, decl);
                    }
                };
                appendDecls(this.sourceDecls);
                appendDecls(BUILTIN_DECLS);
            }
            return this.defineDeclByName.get(name) || null;
        },
        setSourceSnapshot(snapshot = {}) {
            if (typeof snapshot.text !== 'string' || !snapshot.filePath) return this;
            this.sourceFilePath = snapshot.filePath;
            this.sourceText = snapshot.text;
            this.sourceRawLines = Array.isArray(snapshot.rawLines) ? snapshot.rawLines : null;
            return this;
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
                this.dimSpecByText.set(key, parseDimSpec(key, this.sourceDecls, null, this));
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
            if (typeof getDeclNameBuckets === 'function') {
                return getDeclNameBuckets(sourceDecls);
            }
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
        cache.assignableInfoByExpr = new Map();
        cache.unresolvedRefsByExpr = new Map();
        cache.paramMetaByText = new Map();
        cache.dimPartsByText = new Map();
        cache.dimSpecByText = new Map();
        cache.callReturnTypeByExpr = new Map();
        cache.numericExprByText = new Map();
        cache.indexedDimCompatByKey = new Map();
        cache.typeCompatByKey = new Map();
        cache.macroDefineByName = new Map();
        cache.defineDeclByName = null;
        cache.sourceFilePath = '';
        cache.sourceText = '';
        cache.sourceRawLines = null;
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
