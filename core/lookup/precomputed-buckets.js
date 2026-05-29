const PRECOMPUTED_DECL_NAME_BUCKETS = '__pawnDeclNameBuckets';
const PRECOMPUTED_VARIABLE_NAME_BUCKETS = '__pawnVariableNameBuckets';
const LAZY_PRECOMPUTE_MIN_DECLS = 32;
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
        if (!variableBuckets.has(name)) {
            variableBuckets.set(name, decl);
        }
    }
    return { nameBuckets, variableBuckets: variableBuckets || EMPTY_VARIABLE_NAME_BUCKETS };
}

function findDeclInNameBuckets(buckets, name, predicate = null) {
    if (!buckets) return null;
    const matches = buckets.get(name);
    if (!matches || matches.length === 0) return null;
    if (!predicate) return matches[0] || null;
    if (matches.length === 1) {
        const match = matches[0];
        return predicate(match) ? match : null;
    }
    for (const decl of matches) {
        if (predicate(decl)) return decl;
    }
    return null;
}

function filterDeclsInNameBuckets(buckets, name, predicate = null) {
    if (!buckets) return [];
    const matches = buckets.get(name);
    if (!matches || matches.length === 0) return [];
    if (!predicate) return matches.slice();
    if (matches.length === 1) {
        const match = matches[0];
        return predicate(match) ? [match] : [];
    }
    const result = [];
    for (const decl of matches) {
        if (predicate(decl)) result.push(decl);
    }
    return result;
}

function findBestDeclInNameBuckets(buckets, name, predicate = null, score = null) {
    if (!buckets) return null;
    const matches = buckets.get(name);
    if (!matches || matches.length === 0) return null;
    if (matches.length === 1) {
        const match = matches[0];
        return !predicate || predicate(match) ? match : null;
    }
    let best = null;
    let bestScore = -Infinity;
    for (const decl of matches) {
        if (predicate && !predicate(decl)) continue;
        const currentScore = score ? score(decl) : 0;
        if (!best || currentScore > bestScore) {
            best = decl;
            bestScore = currentScore;
        }
    }
    return best;
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
    findBestDeclInNameBuckets,
    findDeclInNameBuckets,
    filterDeclsInNameBuckets,
    getPrecomputedDeclNameBuckets,
    getPrecomputedVariableNameBuckets
};
