function createDeclarationPredicateCore() {
    function isFunctionLikeDefineDecl(data) {
        return !!data && data.type === 'define' && data.macroStyle === 'paren';
    }

    function isObjectLikeDefineDecl(data) {
        return !!data && data.type === 'define' && !data.macroStyle;
    }

    function isFunctionLikeDecl(data) {
        if (!data) return false;
        if (data.type === 'define') return isFunctionLikeDefineDecl(data);
        if (data.type === 'builtin') return !!data.args;
        return data.type !== 'variable' && data.type !== 'enum' && data.type !== 'enum-item';
    }

    return {
        isFunctionLikeDefineDecl,
        isObjectLikeDefineDecl,
        isFunctionLikeDecl
    };
}

module.exports = { createDeclarationPredicateCore };
