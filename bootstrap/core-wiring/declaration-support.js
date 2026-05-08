const {
    createDeclarationScopeCore,
    createDeclarationPredicateCore
} = require('../../core/declarations/index');
const { createDeclLookupCore } = require('../../core/lookup/index');
const { createEnumCore } = require('../../core/enums/index');
const { createRenderCore } = require('../../core/render/index');

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
