const PRECOMPUTED_DECL_NAME_BUCKETS = '__pawnDeclNameBuckets';
const PRECOMPUTED_VARIABLE_NAME_BUCKETS = '__pawnVariableNameBuckets';

function getPrecomputedDeclNameBuckets(decls) {
    return Array.isArray(decls) && decls[PRECOMPUTED_DECL_NAME_BUCKETS] instanceof Map
        ? decls[PRECOMPUTED_DECL_NAME_BUCKETS]
        : null;
}

function getPrecomputedVariableNameBuckets(decls) {
    return Array.isArray(decls) && decls[PRECOMPUTED_VARIABLE_NAME_BUCKETS] instanceof Map
        ? decls[PRECOMPUTED_VARIABLE_NAME_BUCKETS]
        : null;
}

function buildDeclBuckets(decls = []) {
    const nameBuckets = new Map();
    const variableBuckets = new Map();
    for (const decl of decls || []) {
        if (!decl?.name) continue;
        const bucket = nameBuckets.get(decl.name);
        if (bucket) bucket.push(decl);
        else nameBuckets.set(decl.name, [decl]);
        if (decl.type === 'variable' && !variableBuckets.get(decl.name)) {
            variableBuckets.set(decl.name, decl);
        }
    }
    return { nameBuckets, variableBuckets };
}

function attachPrecomputedDeclBuckets(decls, nameBuckets, variableBuckets) {
    if (!Array.isArray(decls)) return decls;
    Object.defineProperties(decls, {
        [PRECOMPUTED_DECL_NAME_BUCKETS]: {
            configurable: true,
            value: nameBuckets
        },
        [PRECOMPUTED_VARIABLE_NAME_BUCKETS]: {
            configurable: true,
            value: variableBuckets
        }
    });
    return decls;
}

function attachBuiltPrecomputedDeclBuckets(decls) {
    if (!Array.isArray(decls)) return decls;
    if (getPrecomputedDeclNameBuckets(decls) && getPrecomputedVariableNameBuckets(decls)) {
        return decls;
    }
    const built = buildDeclBuckets(decls);
    return attachPrecomputedDeclBuckets(decls, built.nameBuckets, built.variableBuckets);
}

module.exports = {
    PRECOMPUTED_DECL_NAME_BUCKETS,
    PRECOMPUTED_VARIABLE_NAME_BUCKETS,
    attachPrecomputedDeclBuckets,
    attachBuiltPrecomputedDeclBuckets,
    buildDeclBuckets,
    getPrecomputedDeclNameBuckets,
    getPrecomputedVariableNameBuckets
};
