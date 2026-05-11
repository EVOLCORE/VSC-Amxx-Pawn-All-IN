const { getPawnIdentifierName } = require('../syntax/identifiers');

function getEnumMemberTagNameForExpression(actualExpr, findDecl) {
    const actualName = getPawnIdentifierName(actualExpr);
    if (!actualName || typeof findDecl !== 'function') return '';
    const enumMemberDecl = findDecl(actualName, item => item?.type === 'enum-item');
    return String(enumMemberDecl?.enumName || '').trim();
}

module.exports = {
    getEnumMemberTagNameForExpression
};
