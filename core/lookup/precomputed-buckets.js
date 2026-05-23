const PRECOMPUTED_DECL_NAME_BUCKETS = '__pawnDeclNameBuckets';
const PRECOMPUTED_VARIABLE_NAME_BUCKETS = '__pawnVariableNameBuckets';
const LAZY_PRECOMPUTE_MIN_DECLS = 8;
const EMPTY_VARIABLE_NAME_BUCKETS = new Map();

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

function hasPrecomputedDeclBucketProperties(decls) {
    if (!Array.isArray(decls)) return false;
    return !!(
        Object.getOwnPropertyDescriptor(decls, PRECOMPUTED_DECL_NAME_BUCKETS) &&
        Object.getOwnPropertyDescriptor(decls, PRECOMPUTED_VARIABLE_NAME_BUCKETS)
    );
}

function buildDeclBuckets(decls = []) {
    const nameBuckets = new Map();
    let variableBuckets = null;
    for (const decl of decls || []) {
        if (!decl) continue;
        const name = decl.name;
        if (!name) continue;
        const bucket = nameBuckets.get(name);
        if (bucket) bucket.push(decl);
        else nameBuckets.set(name, [decl]);
        if (decl.type !== 'variable') continue;
        if (!variableBuckets) variableBuckets = new Map();
        if (!variableBuckets.get(name)) {
            variableBuckets.set(name, decl);
        }
    }
    return { nameBuckets, variableBuckets: variableBuckets || EMPTY_VARIABLE_NAME_BUCKETS };
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

function attachLazyPrecomputedDeclBuckets(decls) {
    if (!Array.isArray(decls)) return decls;
    if (decls.length < LAZY_PRECOMPUTE_MIN_DECLS) return decls;
    if (hasPrecomputedDeclBucketProperties(decls)) {
        return decls;
    }

    let built = null;
    const ensureBuilt = () => {
        if (!built) built = buildDeclBuckets(decls);
        attachPrecomputedDeclBuckets(decls, built.nameBuckets, built.variableBuckets);
        return built;
    };

    Object.defineProperties(decls, {
        [PRECOMPUTED_DECL_NAME_BUCKETS]: {
            configurable: true,
            get() {
                return ensureBuilt().nameBuckets;
            }
        },
        [PRECOMPUTED_VARIABLE_NAME_BUCKETS]: {
            configurable: true,
            get() {
                return ensureBuilt().variableBuckets;
            }
        }
    });
    return decls;
}

module.exports = {
    PRECOMPUTED_DECL_NAME_BUCKETS,
    PRECOMPUTED_VARIABLE_NAME_BUCKETS,
    attachPrecomputedDeclBuckets,
    attachBuiltPrecomputedDeclBuckets,
    attachLazyPrecomputedDeclBuckets,
    buildDeclBuckets,
    getPrecomputedDeclNameBuckets,
    getPrecomputedVariableNameBuckets
};
