function getDeclModifiers(decl) {
    return Array.isArray(decl?.modifiers) ? decl.modifiers : [];
}

function hasDeclModifier(decl, modifier) {
    const target = String(modifier || '');
    if (!target) return false;
    const modifiers = getDeclModifiers(decl);
    for (const value of modifiers) {
        if (value === target) return true;
    }
    return false;
}

function hasAnyDeclModifier(decl, modifiersToFind = []) {
    const modifiers = getDeclModifiers(decl);
    if (!modifiers.length || !Array.isArray(modifiersToFind) || !modifiersToFind.length) {
        return false;
    }
    for (const value of modifiers) {
        for (const target of modifiersToFind) {
            if (value === target) return true;
        }
    }
    return false;
}

module.exports = {
    getDeclModifiers,
    hasAnyDeclModifier,
    hasDeclModifier
};
