const { attachPrecomputedDeclBuckets } = require('../lookup/precomputed-buckets');

function buildIncludeDeclIndexes(decls = []) {
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

function serializeIncludeDeclIndexes(decls = []) {
    if (!Array.isArray(decls) || decls.length === 0) return null;
    const nameBuckets = new Map();
    const variableBuckets = new Map();
    for (let index = 0; index < decls.length; index++) {
        const decl = decls[index];
        if (!decl?.name) continue;
        const bucket = nameBuckets.get(decl.name);
        if (bucket) bucket.push(index);
        else nameBuckets.set(decl.name, [index]);
        if (decl.type === 'variable' && !variableBuckets.has(decl.name)) {
            variableBuckets.set(decl.name, index);
        }
    }
    if (!nameBuckets.size && !variableBuckets.size) return null;
    return {
        n: [...nameBuckets.entries()],
        v: [...variableBuckets.entries()]
    };
}

function reviveIncludeDeclIndexes(decls = [], serializedIndexes = null) {
    if (!Array.isArray(decls) || !serializedIndexes || typeof serializedIndexes !== 'object') {
        return null;
    }
    const nameBuckets = new Map();
    const variableBuckets = new Map();
    if (Array.isArray(serializedIndexes.n)) {
        for (const row of serializedIndexes.n) {
            if (!Array.isArray(row) || row.length < 2) return null;
            const name = String(row[0] || '');
            const indexes = Array.isArray(row[1]) ? row[1] : [];
            if (!name || !indexes.length) continue;
            const bucket = [];
            for (const index of indexes) {
                if (!Number.isInteger(index) || index < 0 || index >= decls.length) return null;
                const decl = decls[index];
                if (!decl || decl.name !== name) return null;
                bucket.push(decl);
            }
            if (bucket.length) nameBuckets.set(name, bucket);
        }
    }
    if (Array.isArray(serializedIndexes.v)) {
        for (const row of serializedIndexes.v) {
            if (!Array.isArray(row) || row.length < 2) return null;
            const name = String(row[0] || '');
            const index = row[1];
            if (!name) continue;
            if (!Number.isInteger(index) || index < 0 || index >= decls.length) return null;
            const decl = decls[index];
            if (!decl || decl.name !== name || decl.type !== 'variable') return null;
            variableBuckets.set(name, decl);
        }
    }
    return { nameBuckets, variableBuckets };
}

function attachIncludeDeclIndexesFromSerializedOrBuild(decls, serializedIndexes = null) {
    const revived = reviveIncludeDeclIndexes(decls, serializedIndexes);
    if (revived) {
        return attachPrecomputedDeclBuckets(decls, revived.nameBuckets, revived.variableBuckets);
    }
    const built = buildIncludeDeclIndexes(decls);
    return attachPrecomputedDeclBuckets(decls, built.nameBuckets, built.variableBuckets);
}

function createIncludeDeclAccumulator() {
    const decls = [];
    const nameBuckets = new Map();
    const variableBuckets = new Map();
    const pushDecl = decl => {
        if (!decl) return;
        decls.push(decl);
        if (!decl.name) return;
        const bucket = nameBuckets.get(decl.name);
        if (bucket) bucket.push(decl);
        else nameBuckets.set(decl.name, [decl]);
        if (decl.type === 'variable' && !variableBuckets.get(decl.name)) {
            variableBuckets.set(decl.name, decl);
        }
    };
    const finish = () => attachPrecomputedDeclBuckets(decls, nameBuckets, variableBuckets);
    return { decls, finish, pushDecl };
}

module.exports = {
    attachIncludeDeclIndexesFromSerializedOrBuild,
    buildIncludeDeclIndexes,
    createIncludeDeclAccumulator,
    serializeIncludeDeclIndexes
};
