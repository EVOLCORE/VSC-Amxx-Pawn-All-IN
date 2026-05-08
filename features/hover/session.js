const {
    getSemanticParsedDeclsMap,
    getSemanticAnalysisCache
} = require('../../core/document-context/semantic-session');

function createLazyArray(resolveItems) {
    let items = null;
    const getItems = () => {
        if (!items) {
            const resolved = typeof resolveItems === 'function' ? resolveItems() : [];
            items = Array.isArray(resolved) ? resolved : [];
        }
        return items;
    };
    return new Proxy([], {
        get(_target, prop) {
            const value = getItems()[prop];
            return typeof value === 'function' ? value.bind(getItems()) : value;
        },
        has(_target, prop) {
            return prop in getItems();
        }
    });
}

function createLazyIncludeLookup(baseLookup, getFullContext, t) {
    let fullLookup = null;
    const getFullLookup = () => {
        if (!fullLookup) {
            const fullContext = typeof getFullContext === 'function' ? getFullContext() : null;
            fullLookup = fullContext?.lookup || baseLookup;
        }
        return fullLookup;
    };

    const findBuiltin = (name, predicate = null) =>
        baseLookup.filterBuiltins(name, predicate)[0] || null;

    const lazyLookup = {
        findFuncArg: name => baseLookup.findFuncArg(name),
        findLocal: name => baseLookup.findLocal(name),
        findGlobal: name => baseLookup.findGlobal(name),
        findFunction: name => baseLookup.findFunction(name),
        findAnyLocalDeclByName(name, predicate = null) {
            return baseLookup.findAnyLocalDeclByName(name, predicate) ||
                getFullLookup().findInclude(name, predicate);
        },
        findAnyDeclByName(name, predicate = null) {
            return baseLookup.findAnyLocalDeclByName(name, predicate) ||
                getFullLookup().findInclude(name, predicate) ||
                findBuiltin(name, predicate);
        },
        findVariable(name) {
            return baseLookup.findFuncArg(name) ||
                baseLookup.findLocal(name) ||
                baseLookup.findGlobal(name) ||
                getFullLookup().findInclude(name, d => d.type === 'variable') ||
                null;
        },
        findInclude: (name, predicate = null) => getFullLookup().findInclude(name, predicate),
        filterIncludes: (name, predicate = null) => getFullLookup().filterIncludes(name, predicate),
        filterBuiltins: (name, predicate = null) => baseLookup.filterBuiltins(name, predicate),
        hasIncludeFunctionTwin: name => getFullLookup().hasIncludeFunctionTwin(name),
        getPreferredFunctionMatch(name, options = {}) {
            if (!options?.preferInclude) {
                const localFunc = baseLookup.findFunction(name);
                if (localFunc) {
                    return { label: t('hover.kind.function'), data: localFunc, nav: true };
                }
            }
            return getFullLookup().getPreferredFunctionMatch(name, options);
        },
        collectWordDecls: name => getFullLookup().collectWordDecls(name)
    };
    Object.defineProperties(lazyLookup, {
        argSet: { get: () => baseLookup.argSet },
        localSet: { get: () => baseLookup.localSet },
        globalSet: { get: () => baseLookup.globalSet },
        functionSet: { get: () => baseLookup.functionSet }
    });
    return lazyLookup;
}

function createHoverSessionFactory(deps) {
    const {
        t,
        getPawnDocumentContext,
        collectIndexedAccessExpressionsFromLine,
        findIndexedAccessContextAtPosition,
        getCtrlCharStateForContent,
        createHoverTypeAnalysisCache
    } = deps;

    function createHoverSession(document, position) {
        const initialLineText = document.lineAt(position.line).text;
        const initialWordRange = document.getWordRangeAtPosition(position);
        const initialWordEnd = initialWordRange?.end?.line === position.line
            ? initialWordRange.end.character
            : -1;
        let initialAfterWord = initialWordEnd;
        while (
            initialAfterWord >= 0 &&
            initialAfterWord < initialLineText.length &&
            /\s/.test(initialLineText[initialAfterWord])
        ) {
            initialAfterWord++;
        }
        const preferFullInitialContext =
            initialAfterWord >= 0 &&
            initialLineText[initialAfterWord] === '(';
        const ctx = preferFullInitialContext
            ? getPawnDocumentContext(document, position.line)
            : getPawnDocumentContext(document, position.line, { includeDecls: false });
        if (!ctx) return null;

        let fullCtx = null;
        const getFullContext = () => {
            if (!fullCtx) {
                fullCtx = preferFullInitialContext
                    ? ctx
                    : (getPawnDocumentContext(document, position.line) || ctx);
            }
            return fullCtx;
        };

        const { fp, text, resolver, parsedDecls } = ctx;
        const incDecls = createLazyArray(() => getFullContext().incDecls);
        const lookup = createLazyIncludeLookup(ctx.lookup, getFullContext, t);
        const allDecls = createLazyArray(() => getFullContext().allDecls);
        const { globals, functions, locals, funcArgs } = parsedDecls;

        lookup.getSemanticAnalysisCache = () => getSemanticAnalysisCache(
            ctx.semanticSession || null,
            ctx.parsedDecls || null,
            lookup,
            createHoverTypeAnalysisCache
        );

        const declarationSourceState = {
            rawLines: ctx.rawLines || text.split(/\r?\n/),
            lineCtrlChars: ctx.lineCtrlChars || resolver.lineCtrlChars || getCtrlCharStateForContent(text, document.fileName).lineCtrlChars
        };
        Object.defineProperty(declarationSourceState, 'lineStartOffsets', {
            enumerable: true,
            configurable: true,
            get() {
                return ctx.lineStartOffsets || null;
            }
        });
        const wordMatchesCache = new Map();
        const getScopedWordMatchesCache = () => {
            return getSemanticParsedDeclsMap(
                ctx.semanticSession || null,
                'wordMatchesByParsedDecls',
                ctx.parsedDecls || null,
                () => new Map()
            ) || wordMatchesCache;
        };
        const getRawIndexedExpressionsForLine = (lineNumber, rawLineText) => {
            const cache = ctx.semanticSession?.rawIndexedExpressionsByLine || null;
            if (!cache) {
                return collectIndexedAccessExpressionsFromLine(
                    rawLineText,
                    resolver.ctrlCharAtLine(lineNumber)
                );
            }
            const cachedExpressions = cache[lineNumber];
            if (cachedExpressions !== undefined) return cachedExpressions;
            const expressions = collectIndexedAccessExpressionsFromLine(
                rawLineText,
                resolver.ctrlCharAtLine(lineNumber)
            );
            cache[lineNumber] = expressions;
            return expressions;
        };
        const findIndexedAccessContextAtPositionCached = hoverPosition => {
            const rawLineText = document.lineAt(hoverPosition.line).text;
            return findIndexedAccessContextAtPosition(
                document,
                hoverPosition,
                resolver,
                { indexedExpressions: getRawIndexedExpressionsForLine(hoverPosition.line, rawLineText) }
            );
        };

        return {
            ctx,
            getFullContext,
            fp,
            text,
            resolver,
            parsedDecls,
            globals,
            functions,
            locals,
            funcArgs,
            incDecls,
            lookup,
            allDecls,
            declarationSourceState,
            getScopedWordMatchesCache,
            getRawIndexedExpressionsForLine,
            findIndexedAccessContextAtPositionCached
        };
    }

    return { createHoverSession };
}

module.exports = {
    createHoverSessionFactory
};
