const { createDeclarationGuardsCore } = require('./runtime');
const { createDeclarationParsingCore } = require('./parsing');
const { createDeclarationScopeCore, computeFunctionRangeMaps } = require('./scope');
const { createDeclarationPredicateCore } = require('./predicates');
const {
    getDeclModifiers,
    hasAnyDeclModifier,
    hasDeclModifier
} = require('./modifiers');

module.exports = {
    createDeclarationGuardsCore,
    createDeclarationParsingCore,
    createDeclarationScopeCore,
    computeFunctionRangeMaps,
    createDeclarationPredicateCore,
    getDeclModifiers,
    hasAnyDeclModifier,
    hasDeclModifier
};
