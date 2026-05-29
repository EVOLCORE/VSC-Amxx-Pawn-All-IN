// Shared declaration-lookup helpers. These are used by multiple hot paths
// (hover, navigation, live validation, document-context building), so keeping
// them in one module makes later optimization safer.
const {
    findBestDeclInNameBuckets,
    findDeclInNameBuckets,
    filterDeclsInNameBuckets,
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
        let variableBuckets = null;
        for (const decl of decls) {
            if (!decl) continue;
            const name = decl.name;
            if (!name) continue;
            const bucket = buckets.get(name);
            if (bucket) {
                bucket.push(decl);
            } else {
                buckets.set(name, [decl]);
            }
            if (shouldBuildVariableBuckets && decl.type === 'variable') {
                if (!variableBuckets) variableBuckets = new Map();
                if (variableBuckets.get(name)) continue;
                variableBuckets.set(name, decl);
            }
        }
        declNameBucketCache.set(decls, buckets);
        if (shouldBuildVariableBuckets) {
            variableNameBucketCache.set(decls, variableBuckets || EMPTY_VARIABLE_NAME_BUCKETS);
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
            if (!decl) continue;
            const name = decl.name;
            if (!name) continue;
            if (nameBuckets) {
                const bucket = nameBuckets.get(name);
                if (bucket) bucket.push(decl);
                else nameBuckets.set(name, [decl]);
            }
            if (decl.type !== 'variable' || buckets.get(name)) continue;
            buckets.set(name, decl);
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
        const anyLocalDeclByNameCache = new Map();
        const anyDeclByNameCache = new Map();
        const defineByNameCache = new Map();
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

        const findAnyLocalDeclByName = (name, predicate = null) => {
            if (!name) return null;
            if (!predicate && anyLocalDeclByNameCache.has(name)) {
                return anyLocalDeclByNameCache.get(name);
            }
            const decl = findDeclInNameBuckets(getFuncArgNameBuckets(), name, predicate) ||
                findDeclInNameBuckets(getLocalNameBuckets(), name, predicate) ||
                findDeclInNameBuckets(getGlobalNameBuckets(), name, predicate) ||
                (predicate ? findDeclInNameBuckets(getFunctionNameBuckets(), name, predicate) : null) ||
                findDeclInNameBuckets(getIncludeNameBuckets(), name, predicate);
            if (!predicate) anyLocalDeclByNameCache.set(name, decl || null);
            return decl || null;
        };

        const findAnyDeclByName = (name, predicate = null) => {
            if (!name) return null;
            if (!predicate && anyDeclByNameCache.has(name)) {
                return anyDeclByNameCache.get(name);
            }
            const decl = findAnyLocalDeclByName(name, predicate) ||
                findDeclInNameBuckets(getBuiltinNameBuckets(), name, predicate);
            if (!predicate) anyDeclByNameCache.set(name, decl || null);
            return decl || null;
        };
        const findDefine = name => {
            if (!name) return null;
            if (defineByNameCache.has(name)) return defineByNameCache.get(name);
            const isDefine = item => item.type === 'define';
            const decl =
                findDeclInNameBuckets(getFuncArgNameBuckets(), name, isDefine) ||
                findDeclInNameBuckets(getLocalNameBuckets(), name, isDefine) ||
                findDeclInNameBuckets(getGlobalNameBuckets(), name, isDefine) ||
                findDeclInNameBuckets(getFunctionNameBuckets(), name, isDefine) ||
                findDeclInNameBuckets(getIncludeNameBuckets(), name, isDefine) ||
                findDeclInNameBuckets(getBuiltinNameBuckets(), name, isDefine) ||
                null;
            defineByNameCache.set(name, decl);
            return decl;
        };

        const lookup = {
            findFuncArg: name => findDeclInNameBuckets(getFuncArgNameBuckets(), name),
            findLocal: name => findDeclInNameBuckets(getLocalNameBuckets(), name),
            findGlobal: name => findDeclInNameBuckets(getGlobalNameBuckets(), name),
            findFunction: name => findDeclInNameBuckets(getFunctionNameBuckets(), name),
            findAnyLocalDeclByName,
            findAnyDeclByName,
            findDocumentVariable: name =>
                getFuncArgVariables().get(name) ||
                getLocalVariables().get(name) ||
                getGlobalVariables().get(name) ||
                null,
            findVariable: name =>
                getFuncArgVariables().get(name) ||
                getLocalVariables().get(name) ||
                getGlobalVariables().get(name) ||
                getIncludeVariables().get(name) ||
                null,
            findInclude: (name, predicate = null) => findDeclInNameBuckets(getIncludeNameBuckets(), name, predicate),
            filterIncludes: (name, predicate = null) => filterDeclsInNameBuckets(getIncludeNameBuckets(), name, predicate),
            filterBuiltins: (name, predicate = null) => filterDeclsInNameBuckets(getBuiltinNameBuckets(), name, predicate),
            findDefine,
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
        if (lookup) {
            pushIf(lookup.findFuncArg(word));
            pushIf(lookup.findLocal(word));
            pushIf(lookup.findGlobal(word));
            pushIf(lookup.findFunction(word));
        } else {
            pushIf(funcArgs.find(d => d.name === word));
            pushIf(locals.find(d => d.name === word));
            pushIf(globals.find(d => d.name === word));
            pushIf(functions.find(d => d.name === word));
        }
        const preferredFunctionMatch = lookup?.getPreferredFunctionMatch(word) || null;
        const preferredIncludeFunc = preferredFunctionMatch?.data || null;
        if (lookup && preferredIncludeFunc?.aliasDefineDecl) {
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
