// Shared declaration-lookup helpers. These are used by multiple hot paths
// (hover, navigation, live validation, document-context building), so keeping
// them in one module makes later optimization safer.
const {
    getPrecomputedDeclNameBuckets,
    getPrecomputedVariableNameBuckets
} = require('./precomputed-buckets');
const { getObjectAliasTargetName } = require('../declarations/aliases');

function createDeclLookupCore(deps) {
    const {
        declNameBucketCache,
        t,
        isFunctionLikeDecl,
        BUILTIN_DECLS = []
    } = deps;
    const variableNameBucketCache = new WeakMap();
    const objectAliasTargetNameCache = new WeakMap();
    const EMPTY_DECL_NAME_BUCKETS = new Map();
    const EMPTY_VARIABLE_NAME_BUCKETS = new Map();

    const findDeclInNameBuckets = (buckets, name, predicate = null) => {
        const matches = buckets.get(name);
        if (!matches?.length) return null;
        if (!predicate) return matches[0];
        for (const decl of matches) {
            if (predicate(decl)) return decl;
        }
        return null;
    };

    const filterDeclsInNameBuckets = (buckets, name, predicate = null) => {
        const matches = buckets.get(name) || [];
        return predicate ? matches.filter(predicate) : [...matches];
    };

    const findBestDeclInNameBuckets = (buckets, name, predicate = null, score = null) => {
        const matches = buckets.get(name);
        if (!matches?.length) return null;
        let best = null;
        let bestScore = -Infinity;
        for (const decl of matches) {
            if (predicate && !predicate(decl)) continue;
            const currentScore = score ? score(decl) : 0;
            if (!best || currentScore > bestScore) {
                best = decl;
                bestScore = currentScore;
            }
        }
        return best;
    };

    const getDeclNameBuckets = decls => {
        if (!Array.isArray(decls) || decls.length === 0) return EMPTY_DECL_NAME_BUCKETS;
        const cached = declNameBucketCache.get(decls);
        if (cached) return cached;
        const precomputed = getPrecomputedDeclNameBuckets(decls);
        if (precomputed) {
            declNameBucketCache.set(decls, precomputed);
            return precomputed;
        }

        const buckets = new Map();
        const shouldBuildVariableBuckets = !variableNameBucketCache.has(decls);
        const variableBuckets = shouldBuildVariableBuckets ? new Map() : null;
        for (const decl of decls) {
            if (!decl?.name) continue;
            const bucket = buckets.get(decl.name);
            if (bucket) {
                bucket.push(decl);
            } else {
                buckets.set(decl.name, [decl]);
            }
            if (variableBuckets && decl.type === 'variable' && !variableBuckets.get(decl.name)) {
                variableBuckets.set(decl.name, decl);
            }
        }
        declNameBucketCache.set(decls, buckets);
        if (variableBuckets) {
            variableNameBucketCache.set(decls, variableBuckets);
        }
        return buckets;
    };

    const findDeclByNameCached = (decls, name, predicate = null) => {
        return findDeclInNameBuckets(getDeclNameBuckets(decls), name, predicate);
    };

    const filterDeclsByNameCached = (decls, name, predicate = null) => {
        return filterDeclsInNameBuckets(getDeclNameBuckets(decls), name, predicate);
    };

    const findBestDeclByNameCached = (decls, name, predicate = null, score = null) => {
        return findBestDeclInNameBuckets(getDeclNameBuckets(decls), name, predicate, score);
    };

    function getCachedObjectAliasTargetName(decl) {
        if (!decl || decl.type !== 'define' || decl.args || decl.macroStyle) return '';
        if (objectAliasTargetNameCache.has(decl)) {
            return objectAliasTargetNameCache.get(decl);
        }
        const result = getObjectAliasTargetName(decl);
        objectAliasTargetNameCache.set(decl, result);
        return result;
    }

    function isObjectFunctionAliasDefine(decl) {
        return !!getCachedObjectAliasTargetName(decl);
    }

    function createFunctionAliasMatch(match, aliasDefine, aliasName, immediateTargetName) {
        if (!match?.data || !aliasDefine || !aliasName) return match;
        const targetDecl = match.data.aliasTargetDecl || match.data;
        const targetName = targetDecl.name || match.data.aliasTargetName || immediateTargetName || '';
        return {
            ...match,
            data: {
                ...targetDecl,
                hoverDisplayName: aliasName,
                aliasName,
                aliasTargetName: targetName,
                aliasImmediateTargetName: immediateTargetName || targetName,
                aliasDefineDecl: aliasDefine,
                aliasTargetDecl: targetDecl
            }
        };
    }

    const getVariableNameBuckets = decls => {
        if (!Array.isArray(decls) || decls.length === 0) return EMPTY_VARIABLE_NAME_BUCKETS;
        const cached = variableNameBucketCache.get(decls);
        if (cached) return cached;
        const precomputed = getPrecomputedVariableNameBuckets(decls);
        if (precomputed) {
            variableNameBucketCache.set(decls, precomputed);
            return precomputed;
        }

        const buckets = new Map();
        const shouldBuildNameBuckets = !declNameBucketCache.has(decls);
        const nameBuckets = shouldBuildNameBuckets ? new Map() : null;
        for (const decl of decls) {
            if (!decl?.name) continue;
            if (nameBuckets) {
                const bucket = nameBuckets.get(decl.name);
                if (bucket) bucket.push(decl);
                else nameBuckets.set(decl.name, [decl]);
            }
            if (decl.type !== 'variable' || buckets.get(decl.name)) continue;
            buckets.set(decl.name, decl);
        }
        variableNameBucketCache.set(decls, buckets);
        if (nameBuckets) {
            declNameBucketCache.set(decls, nameBuckets);
        }
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
        let funcArgNameBuckets = null;
        let localNameBuckets = null;
        let globalNameBuckets = null;
        let functionNameBuckets = null;
        let includeNameBuckets = null;
        let builtinNameBuckets = null;
        const getArgSet = () => (argSet ||= new Set(funcArgs));
        const getLocalSet = () => (localSet ||= new Set(locals));
        const getGlobalSet = () => (globalSet ||= new Set(globals));
        const getFunctionSet = () => (functionSet ||= new Set(functions));
        const getFuncArgVariables = () => (funcArgVariables ||= getVariableNameBuckets(funcArgs));
        const getLocalVariables = () => (localVariables ||= getVariableNameBuckets(locals));
        const getGlobalVariables = () => (globalVariables ||= getVariableNameBuckets(globals));
        const getIncludeVariables = () => (includeVariables ||= getVariableNameBuckets(incDecls));
        const getFuncArgNameBuckets = () => (funcArgNameBuckets ||= getDeclNameBuckets(funcArgs));
        const getLocalNameBuckets = () => (localNameBuckets ||= getDeclNameBuckets(locals));
        const getGlobalNameBuckets = () => (globalNameBuckets ||= getDeclNameBuckets(globals));
        const getFunctionNameBuckets = () => (functionNameBuckets ||= getDeclNameBuckets(functions));
        const getIncludeNameBuckets = () => (includeNameBuckets ||= getDeclNameBuckets(incDecls));
        const getBuiltinNameBuckets = () => (builtinNameBuckets ||= getDeclNameBuckets(BUILTIN_DECLS));

        const findObjectFunctionAliasDefine = name =>
            findDeclInNameBuckets(getFuncArgNameBuckets(), name, isObjectFunctionAliasDefine) ||
            findDeclInNameBuckets(getLocalNameBuckets(), name, isObjectFunctionAliasDefine) ||
            findDeclInNameBuckets(getGlobalNameBuckets(), name, isObjectFunctionAliasDefine) ||
            findDeclInNameBuckets(getFunctionNameBuckets(), name, isObjectFunctionAliasDefine) ||
            findDeclInNameBuckets(getIncludeNameBuckets(), name, isObjectFunctionAliasDefine) ||
            findDeclInNameBuckets(getBuiltinNameBuckets(), name, isObjectFunctionAliasDefine);

        const getDirectPreferredFunctionMatch = (name, preferInclude = false) => {
            const localFunc = findDeclInNameBuckets(getFunctionNameBuckets(), name);
            const includeFunc = findBestDeclInNameBuckets(
                getIncludeNameBuckets(),
                name,
                isFunctionLikeDecl,
                candidate => candidate.lineNumber ?? -1
            );

            let match = null;
            if (preferInclude) {
                if (includeFunc) match = { label: t('hover.kind.include'), data: includeFunc, nav: true };
                else if (localFunc) match = { label: t('hover.kind.function'), data: localFunc, nav: true };
            } else {
                if (localFunc) match = { label: t('hover.kind.function'), data: localFunc, nav: true };
                else if (includeFunc) match = { label: t('hover.kind.include'), data: includeFunc, nav: true };
            }
            return match;
        };

        const resolveFunctionAliasMatch = (name, options = {}, visited = new Set()) => {
            if (!name || visited.has(name)) return null;
            visited.add(name);
            const aliasDefine = findObjectFunctionAliasDefine(name);
            const targetName = getCachedObjectAliasTargetName(aliasDefine);
            if (!targetName || visited.has(targetName)) return null;
            const preferInclude = !!options.preferInclude;
            const targetMatch =
                getDirectPreferredFunctionMatch(targetName, preferInclude) ||
                resolveFunctionAliasMatch(targetName, options, visited);
            return targetMatch
                ? createFunctionAliasMatch(targetMatch, aliasDefine, name, targetName)
                : null;
        };

        const getPreferredFunctionMatch = (name, options = {}) => {
            if (!name) return null;
            const preferInclude = !!options.preferInclude;
            const cacheKey = `${preferInclude ? '1' : '0'}::${name}`;
            if (preferredFunctionMatchCache.has(cacheKey)) {
                return preferredFunctionMatchCache.get(cacheKey);
            }

            const match =
                getDirectPreferredFunctionMatch(name, preferInclude) ||
                resolveFunctionAliasMatch(name, options);

            preferredFunctionMatchCache.set(cacheKey, match);
            return match;
        };

        const lookup = {
            findFuncArg: name => findDeclInNameBuckets(getFuncArgNameBuckets(), name),
            findLocal: name => findDeclInNameBuckets(getLocalNameBuckets(), name),
            findGlobal: name => findDeclInNameBuckets(getGlobalNameBuckets(), name),
            findFunction: name => findDeclInNameBuckets(getFunctionNameBuckets(), name),
            findAnyLocalDeclByName(name, predicate = null) {
                return findDeclInNameBuckets(getFuncArgNameBuckets(), name, predicate) ||
                    findDeclInNameBuckets(getLocalNameBuckets(), name, predicate) ||
                    findDeclInNameBuckets(getGlobalNameBuckets(), name, predicate) ||
                    (predicate ? findDeclInNameBuckets(getFunctionNameBuckets(), name, predicate) : null) ||
                    findDeclInNameBuckets(getIncludeNameBuckets(), name, predicate);
            },
            findAnyDeclByName(name, predicate = null) {
                const localDecl = this.findAnyLocalDeclByName(name, predicate);
                if (localDecl) return localDecl;
                return findDeclInNameBuckets(getBuiltinNameBuckets(), name, predicate);
            },
            findVariable: name =>
                getFuncArgVariables().get(name) ||
                getLocalVariables().get(name) ||
                getGlobalVariables().get(name) ||
                getIncludeVariables().get(name) ||
                null,
            findInclude: (name, predicate = null) => findDeclInNameBuckets(getIncludeNameBuckets(), name, predicate),
            filterIncludes: (name, predicate = null) => filterDeclsInNameBuckets(getIncludeNameBuckets(), name, predicate),
            filterBuiltins: (name, predicate = null) => filterDeclsInNameBuckets(getBuiltinNameBuckets(), name, predicate),
            hasIncludeFunctionTwin: name => !!findDeclInNameBuckets(getIncludeNameBuckets(), name, isFunctionLikeDecl),
            getPreferredFunctionMatch,
            collectWordDecls: name => [
                ...filterDeclsInNameBuckets(getFuncArgNameBuckets(), name),
                ...filterDeclsInNameBuckets(getLocalNameBuckets(), name),
                ...filterDeclsInNameBuckets(getGlobalNameBuckets(), name),
                ...filterDeclsInNameBuckets(getFunctionNameBuckets(), name),
                ...filterDeclsInNameBuckets(getIncludeNameBuckets(), name),
                ...filterDeclsInNameBuckets(getBuiltinNameBuckets(), name)
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
        const targetData = data?.aliasTargetDecl || data;
        return [
            targetData?.filePath || '',
            targetData?.lineNumber ?? '',
            targetData?.name || '',
            targetData?.type || '',
            targetData?.args || '',
            targetData?.value || '',
            data?.aliasName || data?.hoverDisplayName || '',
            data?.aliasDefineDecl?.filePath || '',
            data?.aliasDefineDecl?.lineNumber ?? ''
        ].join('|');
    }

    function getDeclMatchLabel(data, argSet, localSet, globalSet, functionSet) {
        const targetData = data?.aliasTargetDecl || data;
        if (argSet.has(targetData)) return t('hover.kind.argument');
        if (localSet.has(targetData)) return targetData.type === 'enum' ? t('hover.kind.localEnum') : t('hover.kind.local');
        if (globalSet.has(targetData)) {
            if (targetData.type === 'enum-item') return t('hover.enumField');
            if (targetData.type === 'enum') return t('hover.kind.enum');
            return t('hover.kind.global');
        }
        if (functionSet.has(targetData)) return t('hover.kind.function');
        if (targetData.type === 'builtin') return t('hover.kind.compiler');
        return t('hover.kind.include');
    }

    function finalizeDeclMatches(rawMatches, argSet, localSet, globalSet, functionSet) {
        const seen = new Set();
        const matches = [];

        for (const data of rawMatches) {
            const label = getDeclMatchLabel(data, argSet, localSet, globalSet, functionSet);
            const navTarget = data?.aliasTargetDecl || data;
            const nav = !argSet.has(navTarget);
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
        const preferredFunctionMatch = lookup?.getPreferredFunctionMatch(word) || null;
        const preferredIncludeFunc = preferredFunctionMatch?.data || null;
        if (preferredIncludeFunc?.aliasDefineDecl) {
            rawMatches.push(preferredIncludeFunc);
        }
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
        const findExactNavigableDecl = finderName => {
            const finders = [
                lookup.findFuncArg,
                lookup.findLocal,
                lookup.findGlobal,
                lookup.findFunction,
                candidateName => lookup.findInclude(candidateName, d => !!d.filePath)
            ];

            for (const finder of finders) {
                const decl = finder(finderName);
                if (decl?.filePath) return decl;
            }
            return null;
        };

        const exactDecl = findExactNavigableDecl(name);
        if (exactDecl) return exactDecl;

        const text = String(name || '');
        if (text && !text.startsWith('@')) {
            const atPublicDecl = findExactNavigableDecl(`@${text}`);
            if (atPublicDecl) return atPublicDecl;
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
