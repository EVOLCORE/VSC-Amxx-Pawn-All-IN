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

module.exports = {
    PRECOMPUTED_DECL_NAME_BUCKETS,
    PRECOMPUTED_VARIABLE_NAME_BUCKETS,
    attachPrecomputedDeclBuckets,
    getPrecomputedDeclNameBuckets,
    getPrecomputedVariableNameBuckets
};
