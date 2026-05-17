const {
    isPawnIdentifierContinueCode,
    isPawnIdentifierStartCode
} = require('./identifiers');
const { isPreprocessorDirectiveLine } = require('./preprocessor-lines');
const { isPawnWhitespaceCode } = require('./whitespace');

function defaultIsFunctionLikeDefineDecl(decl) {
    return !!decl && decl.type === 'define' && decl.macroStyle === 'paren';
}

function readLeadingFunctionLikeDefineCall(source) {
    const text = String(source || '');
    let cursor = 0;
    while (cursor < text.length && isPawnWhitespaceCode(text.charCodeAt(cursor))) cursor++;
    const nameStart = cursor;
    if (!isPawnIdentifierStartCode(text.charCodeAt(cursor))) return null;
    cursor++;
    while (cursor < text.length && isPawnIdentifierContinueCode(text.charCodeAt(cursor))) cursor++;
    const nameEnd = cursor;
    const name = text.slice(nameStart, nameEnd);
    while (cursor < text.length && isPawnWhitespaceCode(text.charCodeAt(cursor))) cursor++;
    if (text[cursor] !== '(') return null;
    return {
        name,
        nameStart,
        nameEnd,
        openIndex: cursor
    };
}

function createEmptyVirtualExpandedLineContext(source, options = {}) {
    const sourceText = options.trimSource === false
        ? String(source || '')
        : String(source || '').trim();
    return {
        sourceText,
        leadingCall: null,
        defineDecl: null,
        expandedText: '',
        expansion: null,
        changed: false,
        complete: true,
        hasExpansion: false,
        isFunctionLikeDefineLine: false
    };
}

function createVirtualExpandedLineContextCore(deps = {}) {
    const {
        macroExpansionCore,
        isFunctionLikeDefineDecl = defaultIsFunctionLikeDefineDecl
    } = deps;
    const functionLikeDefineCache = new WeakMap();

    function getFunctionLikeDefineMap(defineDecls = []) {
        if (!Array.isArray(defineDecls)) return null;
        const cached = functionLikeDefineCache.get(defineDecls);
        if (
            cached &&
            cached.length === defineDecls.length &&
            cached.first === defineDecls[0] &&
            cached.last === defineDecls[defineDecls.length - 1]
        ) {
            return cached.map;
        }
        const map = new Map();
        for (const decl of defineDecls) {
            if (decl?.name && isFunctionLikeDefineDecl(decl)) {
                map.set(decl.name, decl);
            }
        }
        functionLikeDefineCache.set(defineDecls, {
            length: defineDecls.length,
            first: defineDecls[0],
            last: defineDecls[defineDecls.length - 1],
            map
        });
        return map;
    }

    function findCoreFunctionLikeDefineDecl(defineDecls = [], name = '') {
        if (!name || !Array.isArray(defineDecls)) return null;
        const map = getFunctionLikeDefineMap(defineDecls);
        return map?.get(name) || null;
    }

    function getLeadingFunctionLikeDefineContext(source, defineDecls = [], options = {}) {
        const leadingCall = readLeadingFunctionLikeDefineCall(source);
        if (!leadingCall) {
            return {
                leadingCall: null,
                defineDecl: null
            };
        }
        const preResolvedDecl = options.defineDecl;
        if (
            preResolvedDecl?.name === leadingCall.name &&
            isFunctionLikeDefineDecl(preResolvedDecl)
        ) {
            return {
                leadingCall,
                defineDecl: preResolvedDecl
            };
        }
        return {
            leadingCall,
            defineDecl: findCoreFunctionLikeDefineDecl(defineDecls, leadingCall.name)
        };
    }

    function getVirtualExpandedLineContext(source, defineDecls = [], options = {}) {
        const context = createEmptyVirtualExpandedLineContext(source, options);
        if (!macroExpansionCore || !Array.isArray(defineDecls) || !defineDecls.length) return context;
        if (!context.sourceText || isPreprocessorDirectiveLine(context.sourceText)) return context;

        const { leadingCall, defineDecl } = getLeadingFunctionLikeDefineContext(context.sourceText, defineDecls, options);
        context.leadingCall = leadingCall;
        context.defineDecl = defineDecl;
        context.isFunctionLikeDefineLine = !!defineDecl;
        if (!defineDecl) return context;

        const escapeChar = options.escapeChar || '';
        const expansion = macroExpansionCore.expandMacros(context.sourceText, defineDecls, {
            ...options,
            escapeChar,
            defineDecls,
            expandActualArgs: options.expandActualArgs === undefined ? false : options.expandActualArgs,
            maxOutputLength: options.maxOutputLength || 8192
        });
        context.expansion = expansion;
        context.changed = !!expansion?.changed;
        context.complete = expansion?.complete !== false;
        if (expansion?.complete && expansion.changed) {
            context.expandedText = options.trimExpanded === false
                ? String(expansion.text || '')
                : String(expansion.text || '').trim();
            context.hasExpansion = !!context.expandedText;
            return context;
        }

        if (options.fallbackToFunctionLikeCall) {
            const closeIndex = macroExpansionCore.findMatchingParenIndex?.(
                context.sourceText,
                leadingCall.openIndex,
                escapeChar
            ) ?? -1;
            if (closeIndex >= 0) {
                const directText = macroExpansionCore.expandFunctionLikeDefineCall(
                    defineDecl,
                    context.sourceText.slice(leadingCall.openIndex + 1, closeIndex),
                    {
                        ...options,
                        escapeChar,
                        defineDecls,
                        expandActualArgs: options.expandActualArgs === undefined ? false : options.expandActualArgs
                    }
                );
                context.expandedText = options.trimExpanded === false
                    ? String(directText || '')
                    : String(directText || '').trim();
                context.hasExpansion = !!context.expandedText;
            }
        }

        return context;
    }

    return {
        findFunctionLikeDefineDecl: findCoreFunctionLikeDefineDecl,
        getLeadingFunctionLikeDefineContext,
        getVirtualExpandedLineContext,
        readLeadingFunctionLikeDefineCall
    };
}

module.exports = {
    createVirtualExpandedLineContextCore
};
