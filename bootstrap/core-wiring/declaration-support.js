const {
    createDeclarationScopeCore
} = require('../../core/declarations/scope');
const {
    createDeclarationPredicateCore
} = require('../../core/declarations/predicates');
const { createDeclLookupCore } = require('../../core/lookup/runtime');
const { createEnumCore } = require('../../core/enums/runtime');
const { createRenderCore } = require('../../core/render/runtime');

function createDeclarationSupportRuntime(deps) {
    const {
        t,
        declNameBucketCache,
        BUILTIN_DECLS,
        getActiveCtrlChar,
        isEscapedQuote,
        stripLineComment,
        netParenDepth,
        measurePawnStringLiteral,
        parseBraceArrayLiteralExpression,
        parseDimsParts,
        parseDimSpec,
        evaluatePawnNumericExpr,
        parseForInit,
        parseDeclLine
    } = deps;

    const scopeRuntime = createDeclarationScopeCore({
        getActiveCtrlChar,
        isEscapedQuote,
        stripLineComment,
        netParenDepth,
        parseForInit,
        parseDeclLine
    });
    const enumRuntime = createEnumCore({
        parseDimsParts,
        evaluatePawnNumericExpr
    });
    const renderRuntime = createRenderCore({
        measurePawnStringLiteral,
        parseBraceArrayLiteralExpression,
        parseDimsParts,
        parseDimSpec
    });
    const predicateRuntime = createDeclarationPredicateCore();
    const lookupRuntime = createDeclLookupCore({
        declNameBucketCache,
        t,
        isFunctionLikeDecl: predicateRuntime.isFunctionLikeDecl,
        BUILTIN_DECLS
    });

    return {
        ...scopeRuntime,
        ...enumRuntime,
        ...renderRuntime,
        ...predicateRuntime,
        ...lookupRuntime
    };
}

module.exports = { createDeclarationSupportRuntime };
