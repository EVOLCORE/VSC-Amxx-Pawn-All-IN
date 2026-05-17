const { getPawnIdentifierName } = require('../syntax/identifiers');

function isObjectAliasDefineDecl(decl) {
    return !!decl && decl.type === 'define' && !decl.args && !decl.macroStyle;
}

function getObjectAliasTargetName(decl) {
    if (!isObjectAliasDefineDecl(decl)) return '';
    const targetName = getPawnIdentifierName(decl.value);
    return targetName && targetName !== decl.name ? targetName : '';
}

module.exports = {
    getObjectAliasTargetName,
    isObjectAliasDefineDecl
};
