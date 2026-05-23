const {
    attachPrecomputedDeclBuckets,
    buildDeclBuckets
} = require('../lookup/precomputed-buckets');

function buildIncludeDeclIndexes(decls = []) {
    return buildDeclBuckets(decls);
}

function getIncludeDeclDedupeKey(decl) {
    if (!decl || typeof decl !== 'object') return '';
    const sep = '\x1f';
    return `${decl.filePath || decl.file || ''}${sep}` +
        `${decl.lineNumber ?? ''}${sep}` +
        `${decl.type || ''}${sep}` +
        `${decl.enumName || ''}${sep}` +
        `${decl.enumDisplayName || ''}${sep}` +
        `${decl.name || ''}${sep}` +
        `${decl.args || ''}${sep}` +
        `${decl.macroStyle || ''}${sep}` +
        `${decl.macroIndexer || ''}${sep}` +
        `${decl.typeTag || ''}${sep}` +
        `${decl.dims || ''}${sep}` +
        `${decl.value || ''}${sep}` +
        `${decl.valueDisplay || ''}`;
}

function getIncludeDeclDedupeFile(decl) {
    return decl?.filePath || decl?.file || '';
}

function normalizeIncludeDeclDedupeValue(value) {
    return value == null ? '' : String(value);
}

function areIncludeDeclsEquivalent(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    return getIncludeDeclDedupeFile(left) === getIncludeDeclDedupeFile(right) &&
        normalizeIncludeDeclDedupeValue(left.lineNumber) === normalizeIncludeDeclDedupeValue(right.lineNumber) &&
        normalizeIncludeDeclDedupeValue(left.type) === normalizeIncludeDeclDedupeValue(right.type) &&
        normalizeIncludeDeclDedupeValue(left.enumName) === normalizeIncludeDeclDedupeValue(right.enumName) &&
        normalizeIncludeDeclDedupeValue(left.enumDisplayName) === normalizeIncludeDeclDedupeValue(right.enumDisplayName) &&
        normalizeIncludeDeclDedupeValue(left.name) === normalizeIncludeDeclDedupeValue(right.name) &&
        normalizeIncludeDeclDedupeValue(left.args) === normalizeIncludeDeclDedupeValue(right.args) &&
        normalizeIncludeDeclDedupeValue(left.macroStyle) === normalizeIncludeDeclDedupeValue(right.macroStyle) &&
        normalizeIncludeDeclDedupeValue(left.macroIndexer) === normalizeIncludeDeclDedupeValue(right.macroIndexer) &&
        normalizeIncludeDeclDedupeValue(left.typeTag) === normalizeIncludeDeclDedupeValue(right.typeTag) &&
        normalizeIncludeDeclDedupeValue(left.dims) === normalizeIncludeDeclDedupeValue(right.dims) &&
        normalizeIncludeDeclDedupeValue(left.value) === normalizeIncludeDeclDedupeValue(right.value) &&
        normalizeIncludeDeclDedupeValue(left.valueDisplay) === normalizeIncludeDeclDedupeValue(right.valueDisplay);
}

function createIncludeDeclDedupeTracker() {
    const namedBuckets = new Map();
    const namelessKeys = new Set();
    return {
        hasOrAdd(decl) {
            if (!decl || typeof decl !== 'object') return false;
            const name = decl.name || '';
            if (!name) {
                const key = getIncludeDeclDedupeKey(decl);
                if (key && namelessKeys.has(key)) return true;
                if (key) namelessKeys.add(key);
                return false;
            }
            const bucket = namedBuckets.get(name);
            if (bucket) {
                for (const existing of bucket) {
                    if (areIncludeDeclsEquivalent(existing, decl)) return true;
                }
                bucket.push(decl);
            } else {
                namedBuckets.set(name, [decl]);
            }
            return false;
        }
    };
}

function dedupeIncludeDecls(decls = []) {
    if (!Array.isArray(decls) || decls.length <= 1) return Array.isArray(decls) ? decls : [];
    const dedupe = createIncludeDeclDedupeTracker();
    const result = [];
    for (const decl of decls) {
        if (dedupe.hasOrAdd(decl)) continue;
        result.push(decl);
    }
    return result;
}

function serializeIncludeDeclIndexes(decls = []) {
    if (!Array.isArray(decls) || decls.length === 0) return null;
    const nameBuckets = new Map();
    const variableBuckets = new Map();
    for (let index = 0; index < decls.length; index++) {
        const decl = decls[index];
        if (!decl) continue;
        const name = decl.name;
        if (!name) continue;
        const bucket = nameBuckets.get(name);
        if (bucket) bucket.push(index);
        else nameBuckets.set(name, [index]);
        if (decl.type === 'variable' && !variableBuckets.has(name)) {
            variableBuckets.set(name, index);
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

function createIncludeDeclAccumulator(options = {}) {
    const shouldDedupe = options.dedupe !== false;
    const decls = [];
    const nameBuckets = new Map();
    const variableBuckets = new Map();
    const seenDecls = shouldDedupe ? createIncludeDeclDedupeTracker() : null;
    const seenDeclRefs = shouldDedupe ? new WeakSet() : null;
    const pushDecl = decl => {
        if (!decl) return;
        if (seenDeclRefs && typeof decl === 'object') {
            if (seenDeclRefs.has(decl)) return;
            seenDeclRefs.add(decl);
        }
        if (seenDecls) {
            if (seenDecls.hasOrAdd(decl)) return;
        }
        decls.push(decl);
        const name = decl.name;
        if (!name) return;
        const bucket = nameBuckets.get(name);
        if (bucket) bucket.push(decl);
        else nameBuckets.set(name, [decl]);
        if (decl.type === 'variable' && !variableBuckets.get(name)) {
            variableBuckets.set(name, decl);
        }
    };
    const finish = () => attachPrecomputedDeclBuckets(decls, nameBuckets, variableBuckets);
    return { decls, finish, pushDecl };
}

module.exports = {
    attachIncludeDeclIndexesFromSerializedOrBuild,
    buildIncludeDeclIndexes,
    createIncludeDeclAccumulator,
    dedupeIncludeDecls,
    serializeIncludeDeclIndexes
};
