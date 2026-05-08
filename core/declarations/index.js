const { createDeclarationGuardsCore } = require('./runtime');
const { createDeclarationParsingCore } = require('./parsing');
const { createDeclarationScopeCore, computeFunctionRangeMaps } = require('./scope');
const { createDeclarationPredicateCore } = require('./predicates');

module.exports = {
    createDeclarationGuardsCore,
    createDeclarationParsingCore,
    createDeclarationScopeCore,
    computeFunctionRangeMaps,
    createDeclarationPredicateCore
};
