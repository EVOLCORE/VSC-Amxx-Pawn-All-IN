// Shared declaration-lookup helpers. These are used by multiple hot paths
// (hover, navigation, live validation, document-context building), so keeping
// them in one module makes later optimization safer.
const {
    getPrecomputedDeclNameBuckets,
    getPrecomputedVariableNameBuckets
} = require('./precomputed-buckets');

function createDeclLookupCore(deps) {
    const {
        declNameBucketCache,
        t,
        isFunctionLikeDecl,
        BUILTIN_DECLS = []
    } = deps;
    const variableNameBucketCache = new WeakMap();

    const getDeclNameBuckets = decls => {
        if (!Array.isArray(decls)) return new Map();
        const cached = declNameBucketCache.get(decls);
        if (cached) return cached;
        const precomputed = getPrecomputedDeclNameBuckets(decls);
        if (precomputed) {
            declNameBucketCache.set(decls, precomputed);
            return precomputed;
        }

        const buckets = new Map();
        for (const decl of decls) {
            if (!decl?.name) continue;
            const bucket = buckets.get(decl.name);
            if (bucket) {
                bucket.push(decl);
            } else {
                buckets.set(decl.name, [decl]);
            }
        }
        declNameBucketCache.set(decls, buckets);
        return buckets;
    };

    const findDeclByNameCached = (decls, name, predicate = null) => {
        const matches = getDeclNameBuckets(decls).get(name);
        if (!matches?.length) return null;
        if (!predicate) return matches[0];
        for (const decl of matches) {
            if (predicate(decl)) return decl;
        }
        return null;
    };

    const filterDeclsByNameCached = (decls, name, predicate = null) => {
        const matches = getDeclNameBuckets(decls).get(name) || [];
        return predicate ? matches.filter(predicate) : [...matches];
    };

    const getVariableNameBuckets = decls => {
        if (!Array.isArray(decls)) return new Map();
        const cached = variableNameBucketCache.get(decls);
        if (cached) return cached;
        const precomputed = getPrecomputedVariableNameBuckets(decls);
        if (precomputed) {
            variableNameBucketCache.set(decls, precomputed);
            return precomputed;
        }

        const buckets = new Map();
        for (const decl of decls) {
            if (decl?.type !== 'variable' || !decl?.name || buckets.get(decl.name)) continue;
            buckets.set(decl.name, decl);
        }
        variableNameBucketCache.set(decls, buckets);
        return buckets;
    };

    function hasIncludeFunctionTwin(name, incDecls, lookup = null) {
        if (!name) return false;
        if (lookup?.hasIncludeFunctionTwin) return lookup.hasIncludeFunctionTwin(name);
        return !!findDeclByNameCached(incDecls, name, isFunctionLikeDecl);
    }

    function isKnownFunctionName(name, functions, incDecls, lookup = null) {
        if (!name) return false;
        if (lookup?.getPreferredFunctionMatch?.(name)) return true;
        return !!findDeclByNameCached(functions, name) || hasIncludeFunctionTwin(name, incDecls, lookup);
    }

    function buildDocumentDeclLookup(parsedDecls, incDecls) {
        const { globals, functions, locals, funcArgs } = parsedDecls;
        const preferredFunctionMatchCache = new Map();
        let argSet = null;
        let localSet = null;
        let globalSet = null;
        let functionSet = null;
        let funcArgVariables = null;
        let localVariables = null;
        let globalVariables = null;
        let includeVariables = null;
        const getArgSet = () => (argSet ||= new Set(funcArgs));
        const getLocalSet = () => (localSet ||= new Set(locals));
        const getGlobalSet = () => (globalSet ||= new Set(globals));
        const getFunctionSet = () => (functionSet ||= new Set(functions));
        const getFuncArgVariables = () => (funcArgVariables ||= getVariableNameBuckets(funcArgs));
        const getLocalVariables = () => (localVariables ||= getVariableNameBuckets(locals));
        const getGlobalVariables = () => (globalVariables ||= getVariableNameBuckets(globals));
        const getIncludeVariables = () => (includeVariables ||= getVariableNameBuckets(incDecls));

        const getPreferredFunctionMatch = (name, options = {}) => {
            if (!name) return null;
            const preferInclude = !!options.preferInclude;
            const cacheKey = `${preferInclude ? '1' : '0'}::${name}`;
            if (preferredFunctionMatchCache.has(cacheKey)) {
                return preferredFunctionMatchCache.get(cacheKey);
            }

            const localFunc = findDeclByNameCached(functions, name);
            const includeCandidates = filterDeclsByNameCached(incDecls, name, isFunctionLikeDecl);
            const includeFunc = includeCandidates.reduce(
                (best, candidate) =>
                    !best || (candidate.lineNumber ?? -1) > (best.lineNumber ?? -1) ? candidate : best,
                null
            );

            let match = null;
            if (preferInclude) {
                if (includeFunc) match = { label: t('hover.kind.include'), data: includeFunc, nav: true };
                else if (localFunc) match = { label: t('hover.kind.function'), data: localFunc, nav: true };
            } else {
                if (localFunc) match = { label: t('hover.kind.function'), data: localFunc, nav: true };
                else if (includeFunc) match = { label: t('hover.kind.include'), data: includeFunc, nav: true };
            }

            preferredFunctionMatchCache.set(cacheKey, match);
            return match;
        };

        const lookup = {
            findFuncArg: name => findDeclByNameCached(funcArgs, name),
            findLocal: name => findDeclByNameCached(locals, name),
            findGlobal: name => findDeclByNameCached(globals, name),
            findFunction: name => findDeclByNameCached(functions, name),
            findAnyLocalDeclByName(name, predicate = null) {
                return findDeclByNameCached(funcArgs, name, predicate) ||
                    findDeclByNameCached(locals, name, predicate) ||
                    findDeclByNameCached(globals, name, predicate) ||
                    (predicate ? findDeclByNameCached(functions, name, predicate) : null) ||
                    findDeclByNameCached(incDecls, name, predicate);
            },
            findAnyDeclByName(name, predicate = null) {
                const localDecl = this.findAnyLocalDeclByName(name, predicate);
                if (localDecl) return localDecl;
                return findDeclByNameCached(BUILTIN_DECLS, name, predicate);
            },
            findVariable: name =>
                getFuncArgVariables().get(name) ||
                getLocalVariables().get(name) ||
                getGlobalVariables().get(name) ||
                getIncludeVariables().get(name) ||
                null,
            findInclude: (name, predicate = null) => findDeclByNameCached(incDecls, name, predicate),
            filterIncludes: (name, predicate = null) => filterDeclsByNameCached(incDecls, name, predicate),
            filterBuiltins: (name, predicate = null) => filterDeclsByNameCached(BUILTIN_DECLS, name, predicate),
            hasIncludeFunctionTwin: name => !!findDeclByNameCached(incDecls, name, isFunctionLikeDecl),
            getPreferredFunctionMatch,
            collectWordDecls: name => [
                ...filterDeclsByNameCached(funcArgs, name),
                ...filterDeclsByNameCached(locals, name),
                ...filterDeclsByNameCached(globals, name),
                ...filterDeclsByNameCached(functions, name),
                ...filterDeclsByNameCached(incDecls, name),
                ...filterDeclsByNameCached(BUILTIN_DECLS, name)
            ]
        };
        Object.defineProperties(lookup, {
            argSet: { get: getArgSet },
            localSet: { get: getLocalSet },
            globalSet: { get: getGlobalSet },
            functionSet: { get: getFunctionSet }
        });
        return lookup;
    }

    function getDeclMatchKey(data) {
        return [
            data?.filePath || '',
            data?.lineNumber ?? '',
            data?.name || '',
            data?.type || '',
            data?.args || '',
            data?.value || ''
        ].join('|');
    }

    function getDeclMatchLabel(data, argSet, localSet, globalSet, functionSet) {
        if (argSet.has(data)) return t('hover.kind.argument');
        if (localSet.has(data)) return data.type === 'enum' ? t('hover.kind.localEnum') : t('hover.kind.local');
        if (globalSet.has(data)) {
            if (data.type === 'enum-item') return t('hover.enumField');
            if (data.type === 'enum') return t('hover.kind.enum');
            return t('hover.kind.global');
        }
        if (functionSet.has(data)) return t('hover.kind.function');
        if (data.type === 'builtin') return t('hover.kind.compiler');
        return t('hover.kind.include');
    }

    function finalizeDeclMatches(rawMatches, argSet, localSet, globalSet, functionSet) {
        const seen = new Set();
        const matches = [];

        for (const data of rawMatches) {
            const label = getDeclMatchLabel(data, argSet, localSet, globalSet, functionSet);
            const nav = !argSet.has(data);
            const key = `${getDeclMatchKey(data)}|${label}`;
            if (seen.has(key)) continue;
            seen.add(key);
            matches.push({ label, data, nav });
        }

        return matches;
    }

    function collectWordDeclMatches(word, funcArgs, locals, globals, functions, incDecls, builtins = BUILTIN_DECLS, lookup = null) {
        const rawMatches = [];
        const pushIf = data => { if (data) rawMatches.push(data); };
        pushIf(lookup?.findFuncArg(word) ?? funcArgs.find(d => d.name === word));
        pushIf(lookup?.findLocal(word) ?? locals.find(d => d.name === word));
        pushIf(lookup?.findGlobal(word) ?? globals.find(d => d.name === word));
        pushIf(lookup?.findFunction(word) ?? functions.find(d => d.name === word));
        const preferredIncludeFunc = (
            lookup?.getPreferredFunctionMatch(word)?.data ||
            null
        );
        rawMatches.push(...(lookup?.filterIncludes(word) ?? incDecls.filter(d =>
            d.name === word &&
            (!isFunctionLikeDecl(d) || d === preferredIncludeFunc)
        )));
        rawMatches.push(...(lookup?.filterBuiltins(word) ?? builtins.filter(d => d.name === word)));

        const argSet = lookup?.argSet || new Set(funcArgs);
        const localSet = lookup?.localSet || new Set(locals);
        const globalSet = lookup?.globalSet || new Set(globals);
        const functionSet = lookup?.functionSet || new Set(functions);
        return finalizeDeclMatches(rawMatches, argSet, localSet, globalSet, functionSet);
    }

    function findFirstNavigableDecl(lookup, name) {
        if (!lookup || !name) return null;
        const finders = [
            lookup.findFuncArg,
            lookup.findLocal,
            lookup.findGlobal,
            lookup.findFunction,
            finderName => lookup.findInclude(finderName, d => !!d.filePath)
        ];

        for (const finder of finders) {
            const decl = finder(name);
            if (decl?.filePath) return decl;
        }
        return null;
    }

    return {
        getDeclNameBuckets,
        findDeclByNameCached,
        filterDeclsByNameCached,
        buildDocumentDeclLookup,
        isKnownFunctionName,
        hasIncludeFunctionTwin,
        getDeclMatchKey,
        finalizeDeclMatches,
        collectWordDeclMatches,
        findFirstNavigableDecl
    };
}

module.exports = { createDeclLookupCore };
