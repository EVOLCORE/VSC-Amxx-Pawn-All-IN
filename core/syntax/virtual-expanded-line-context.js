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

function findFunctionLikeDefineDecl(defineDecls = [], name = '', isFunctionLikeDefineDecl = defaultIsFunctionLikeDefineDecl) {
    if (!name || !Array.isArray(defineDecls)) return null;
    for (const decl of defineDecls) {
        if (decl?.name === name && isFunctionLikeDefineDecl(decl)) return decl;
    }
    return null;
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

    function getLeadingFunctionLikeDefineContext(source, defineDecls = []) {
        const leadingCall = readLeadingFunctionLikeDefineCall(source);
        if (!leadingCall) {
            return {
                leadingCall: null,
                defineDecl: null
            };
        }
        return {
            leadingCall,
            defineDecl: findFunctionLikeDefineDecl(
                defineDecls,
                leadingCall.name,
                isFunctionLikeDefineDecl
            )
        };
    }

    function getVirtualExpandedLineContext(source, defineDecls = [], options = {}) {
        const context = createEmptyVirtualExpandedLineContext(source, options);
        if (!macroExpansionCore || !Array.isArray(defineDecls) || !defineDecls.length) return context;
        if (!context.sourceText || isPreprocessorDirectiveLine(context.sourceText)) return context;

        const { leadingCall, defineDecl } = getLeadingFunctionLikeDefineContext(context.sourceText, defineDecls);
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
        findFunctionLikeDefineDecl: (defineDecls, name) =>
            findFunctionLikeDefineDecl(defineDecls, name, isFunctionLikeDefineDecl),
        getLeadingFunctionLikeDefineContext,
        getVirtualExpandedLineContext,
        readLeadingFunctionLikeDefineCall
    };
}

module.exports = {
    createVirtualExpandedLineContextCore,
    readLeadingFunctionLikeDefineCall,
    findFunctionLikeDefineDecl
};
