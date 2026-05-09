const crypto = require('crypto');
const { getDefineStateSignature } = require('../utils/signature');

function createIncludePersistentCache(deps) {
    const {
        fs,
        path,
        normalizeFsPath,
        persistentIncludeDeclCacheRoot = '',
        persistentIncludeDeclCacheMaxBytes = 24 * 1024 * 1024,
        getDefineStateKey,
        getSearchPathSignature,
        getFileStamp,
        isSameFileStamp,
        areDependencyStampsFresh,
        buildDependencyStampMap,
        buildIncludeEntriesSignatureHash,
        getActiveFilesSignature,
        reviveIncludeDecls,
        serializeIncludeDeclIndexes,
        INCLUDE_DECL_COMPACT_SIGNATURE,
        deserializeDependencyStamps,
        getSerializedIncludeEntryFilePath,
        revivePreprocessedState,
        serializeDependencyStamps,
        serializeIncludeDecls,
        serializePreprocessedState
    } = deps;

    const INCLUDE_DECL_PERSISTENT_CACHE_SCHEMA = 'include-decls';
    const INCLUDE_PREPROCESSED_PERSISTENT_CACHE_SCHEMA = 'include-preprocessed-rational';
    const ACTIVE_INCLUDE_DECL_PERSISTENT_CACHE_SCHEMA = 'active-include-decls';
    const INCLUDE_DECL_PERSISTENT_CACHE_DIR_NAME = 'amxx-pawn-all-in-cache';
    const PERSISTENT_INCLUDE_DECL_CACHE_DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
    const PERSISTENT_INCLUDE_DECL_CACHE_MAX_BYTES_LIMIT = 256 * 1024 * 1024;
    const PERSISTENT_INCLUDE_DECL_CACHE_MAX_FILES = 512;
    const PERSISTENT_INCLUDE_DECL_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const PERSISTENT_INCLUDE_DECL_CACHE_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
    let lastPersistentIncludeDeclCachePruneAt = 0;
    let persistentIncludeDeclCachePruneScheduled = false;

    function getPersistentIncludeDeclCacheMaxBytes() {
        const rawValue = typeof persistentIncludeDeclCacheMaxBytes === 'function'
            ? persistentIncludeDeclCacheMaxBytes()
            : persistentIncludeDeclCacheMaxBytes;
        const numericValue = Number(rawValue);
        if (!Number.isFinite(numericValue)) return PERSISTENT_INCLUDE_DECL_CACHE_DEFAULT_MAX_BYTES;
        if (numericValue <= 0) return 0;
        return Math.min(PERSISTENT_INCLUDE_DECL_CACHE_MAX_BYTES_LIMIT, Math.floor(numericValue));
    }

    function isPersistentIncludeDeclCacheEnabled() {
        return getPersistentIncludeDeclCacheMaxBytes() > 0;
    }

    function getPersistentIncludeDeclCacheMaxEntryBytes() {
        const maxBytes = getPersistentIncludeDeclCacheMaxBytes();
        if (maxBytes <= 0) return 0;
        return Math.max(512 * 1024, Math.floor(maxBytes / 4));
    }

    function getPersistentIncludeDeclCacheDirectory(options = {}) {
        if (options.ignoreEnabled !== true && !isPersistentIncludeDeclCacheEnabled()) return '';
        const root = String(persistentIncludeDeclCacheRoot || '').trim();
        return root ? path.join(root, INCLUDE_DECL_PERSISTENT_CACHE_DIR_NAME) : '';
    }

    function getPersistentIncludeCacheFilePath(schema, parts = []) {
        const cacheDir = getPersistentIncludeDeclCacheDirectory();
        if (!cacheDir) return '';
        const key = [schema, ...parts.map(part => String(part || ''))].join('\n');
        const hash = crypto.createHash('sha1').update(key).digest('hex');
        return path.join(cacheDir, `${hash}.json`);
    }

    function isPersistentDefineStateMatch(payload, defineStateKey, defineDecls = []) {
        return String(payload?.h || '') === getDefineStateSignature(defineDecls, defineStateKey);
    }

    function getPersistentIncludeDeclCacheFilePath(filePath, defineStateKey, searchPathSignature, defineDecls = []) {
        return getPersistentIncludeCacheFilePath(INCLUDE_DECL_PERSISTENT_CACHE_SCHEMA, [
            normalizeFsPath(filePath),
            getDefineStateSignature(defineDecls, defineStateKey),
            String(searchPathSignature || '')
        ]);
    }

    function getPersistentIncludePreprocessedCacheFilePath(filePath, defineStateKey, searchPathSignature, activeFilesSignature, includeDepth, defineDecls = []) {
        return getPersistentIncludeCacheFilePath(INCLUDE_PREPROCESSED_PERSISTENT_CACHE_SCHEMA, [
            normalizeFsPath(filePath),
            getDefineStateSignature(defineDecls, defineStateKey),
            String(searchPathSignature || ''),
            String(activeFilesSignature || ''),
            String(Number.isInteger(includeDepth) ? includeDepth : 0)
        ]);
    }

    function getActiveIncludeEntriesSignatureHash(includeEntries = []) {
        return buildIncludeEntriesSignatureHash(
            includeEntries,
            normalizeFsPath,
            entry => getDefineStateSignature(entry?.defineDecls || [], entry?.defineStateKey || ''),
            { emptySignature: '' }
        );
    }

    function getPersistentActiveIncludeDeclCacheFilePath(includeEntriesSignatureHash, searchPathSignature) {
        return getPersistentIncludeCacheFilePath(ACTIVE_INCLUDE_DECL_PERSISTENT_CACHE_SCHEMA, [
            String(includeEntriesSignatureHash || ''),
            String(searchPathSignature || '')
        ]);
    }

    function schedulePersistentIncludeCacheWrite(cacheFilePath, payload) {
        setTimeout(() => {
            if (!isPersistentIncludeDeclCacheEnabled()) return;
            const currentCacheDir = getPersistentIncludeDeclCacheDirectory();
            if (!currentCacheDir || path.resolve(path.dirname(cacheFilePath)) !== path.resolve(currentCacheDir)) {
                return;
            }
            let payloadText = '';
            try {
                payloadText = JSON.stringify(payload);
            } catch {
                return;
            }
            const maxEntryBytes = getPersistentIncludeDeclCacheMaxEntryBytes();
            if (maxEntryBytes <= 0 || Buffer.byteLength(payloadText, 'utf8') > maxEntryBytes) {
                return;
            }
            fs.promises.mkdir(path.dirname(cacheFilePath), { recursive: true })
                .then(() => fs.promises.writeFile(cacheFilePath, payloadText, 'utf8'))
                .then(() => prunePersistentIncludeDeclCache())
                .catch(() => {});
        }, 0);
    }

    function canUsePersistentIncludeDeclCache(fileStamp) {
        return !!(
            isPersistentIncludeDeclCacheEnabled() &&
            String(persistentIncludeDeclCacheRoot || '').trim() &&
            fileStamp &&
            fileStamp.kind !== 'document'
        );
    }

    function readPersistentIncludeDeclCache(filePath, defineStateKey, fileStamp, searchPathSignature, defineDecls = []) {
        if (!canUsePersistentIncludeDeclCache(fileStamp)) return null;
        const cacheFilePath = getPersistentIncludeDeclCacheFilePath(filePath, defineStateKey, searchPathSignature, defineDecls);
        if (!cacheFilePath || !fs.existsSync(cacheFilePath)) return null;
        try {
            const payload = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
            if (payload?.s !== INCLUDE_DECL_PERSISTENT_CACHE_SCHEMA) return null;
            if (String(payload.k || '') !== INCLUDE_DECL_COMPACT_SIGNATURE) return null;
            if (normalizeFsPath(payload.p) !== normalizeFsPath(filePath)) return null;
            if (!isPersistentDefineStateMatch(payload, defineStateKey, defineDecls)) return null;
            if (String(payload.q || '') !== String(searchPathSignature || '')) return null;
            if (!isSameFileStamp(payload.m, fileStamp)) return null;
            const dependencyStamps = deserializeDependencyStamps(payload.x);
            if (!dependencyStamps || !areDependencyStampsFresh(dependencyStamps)) return null;
            return {
                decls: reviveIncludeDecls(payload.l || [], filePath),
                dependencyStamps
            };
        } catch {
            return null;
        }
    }

    function writePersistentIncludeDeclCache(filePath, defineStateKey, fileStamp, searchPathSignature, decls, dependencyStamps, defineDecls = []) {
        if (!canUsePersistentIncludeDeclCache(fileStamp)) return;
        const cacheFilePath = getPersistentIncludeDeclCacheFilePath(filePath, defineStateKey, searchPathSignature, defineDecls);
        if (!cacheFilePath) return;
        const payload = {
            s: INCLUDE_DECL_PERSISTENT_CACHE_SCHEMA,
            p: normalizeFsPath(filePath),
            h: getDefineStateSignature(defineDecls, defineStateKey),
            q: String(searchPathSignature || ''),
            k: INCLUDE_DECL_COMPACT_SIGNATURE,
            m: fileStamp,
            x: serializeDependencyStamps(dependencyStamps),
            l: serializeIncludeDecls(decls)
        };
        schedulePersistentIncludeCacheWrite(cacheFilePath, payload);
    }

    function canUsePersistentActiveIncludeDeclCache(includeEntries = []) {
        return isPersistentIncludeDeclCacheEnabled() &&
            !!String(persistentIncludeDeclCacheRoot || '').trim() &&
            Array.isArray(includeEntries) &&
            includeEntries.length > 0;
    }

    function readPersistentActiveIncludeDeclCache(docFilePath, includeEntries, searchPathSignature) {
        if (!canUsePersistentActiveIncludeDeclCache(includeEntries)) return null;
        const includeEntriesSignatureHash = getActiveIncludeEntriesSignatureHash(includeEntries);
        if (!includeEntriesSignatureHash) return null;
        const cacheFilePath = getPersistentActiveIncludeDeclCacheFilePath(
            includeEntriesSignatureHash,
            searchPathSignature
        );
        if (!cacheFilePath || !fs.existsSync(cacheFilePath)) return null;
        try {
            const payload = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
            if (payload?.s !== ACTIVE_INCLUDE_DECL_PERSISTENT_CACHE_SCHEMA) return null;
            if (String(payload.k || '') !== INCLUDE_DECL_COMPACT_SIGNATURE) return null;
            if (String(payload.q || '') !== String(searchPathSignature || '')) return null;
            if (String(payload.g || '') !== includeEntriesSignatureHash) return null;
            const dependencyStamps = deserializeDependencyStamps(payload.x);
            if (!dependencyStamps || !areDependencyStampsFresh(dependencyStamps)) return null;
            return {
                decls: reviveIncludeDecls(payload.l || [], docFilePath, {
                    attachIndexes: true,
                    groupDocsByDeclFile: true,
                    indexes: payload.j
                }),
                dependencyStamps
            };
        } catch {
            return null;
        }
    }

    function writePersistentActiveIncludeDeclCache(includeEntries, searchPathSignature, decls, dependencyStamps) {
        if (!canUsePersistentActiveIncludeDeclCache(includeEntries)) return;
        const includeEntriesSignatureHash = getActiveIncludeEntriesSignatureHash(includeEntries);
        if (!includeEntriesSignatureHash) return;
        const cacheFilePath = getPersistentActiveIncludeDeclCacheFilePath(
            includeEntriesSignatureHash,
            searchPathSignature
        );
        if (!cacheFilePath) return;
        const payload = {
            s: ACTIVE_INCLUDE_DECL_PERSISTENT_CACHE_SCHEMA,
            q: String(searchPathSignature || ''),
            g: includeEntriesSignatureHash,
            k: INCLUDE_DECL_COMPACT_SIGNATURE,
            x: serializeDependencyStamps(dependencyStamps),
            l: serializeIncludeDecls(decls),
            j: serializeIncludeDeclIndexes(decls)
        };
        schedulePersistentIncludeCacheWrite(cacheFilePath, payload);
    }

    function readPersistentIncludePreprocessedState(filePath, defineStateKey, options = {}) {
        const fileStamp = getFileStamp(filePath);
        if (!canUsePersistentIncludeDeclCache(fileStamp)) return null;
        const searchPathSignature = getSearchPathSignature(filePath);
        const activeFilesSignature = getActiveFilesSignature(options.activeFiles);
        const includeDepth = Number.isInteger(options.includeDepth) ? options.includeDepth : 0;
        const cacheFilePath = getPersistentIncludePreprocessedCacheFilePath(
            filePath,
            defineStateKey,
            searchPathSignature,
            activeFilesSignature,
            includeDepth,
            options.baseDefineDecls || []
        );
        if (!cacheFilePath || !fs.existsSync(cacheFilePath)) return null;
        try {
            const payload = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
            if (payload?.s !== INCLUDE_PREPROCESSED_PERSISTENT_CACHE_SCHEMA) return null;
            if (normalizeFsPath(payload.p) !== normalizeFsPath(filePath)) return null;
            if (!isPersistentDefineStateMatch(payload, defineStateKey, options.baseDefineDecls || [])) return null;
            if (String(payload.q || '') !== String(searchPathSignature || '')) return null;
            if (String(payload.a || '') !== String(activeFilesSignature || '')) return null;
            if ((payload.n ?? 0) !== includeDepth) return null;
            if (!isSameFileStamp(payload.m, fileStamp)) return null;
            const dependencyStamps = deserializeDependencyStamps(payload.x);
            if (!dependencyStamps || !areDependencyStampsFresh(dependencyStamps)) return null;
            return revivePreprocessedState(payload.r, options.baseDefineDecls);
        } catch {
            return null;
        }
    }

    function writePersistentIncludePreprocessedState(filePath, defineStateKey, state, options = {}) {
        const fileStamp = getFileStamp(filePath);
        if (!canUsePersistentIncludeDeclCache(fileStamp)) return;
        const searchPathSignature = getSearchPathSignature(filePath);
        const activeFilesSignature = getActiveFilesSignature(options.activeFiles);
        const includeDepth = Number.isInteger(options.includeDepth) ? options.includeDepth : 0;
        const cacheFilePath = getPersistentIncludePreprocessedCacheFilePath(
            filePath,
            defineStateKey,
            searchPathSignature,
            activeFilesSignature,
            includeDepth,
            options.baseDefineDecls || []
        );
        if (!cacheFilePath) return;
        const serializedState = serializePreprocessedState(state, options.baseDefineDecls);
        if (!serializedState) return;
        const dependencyStamps = buildDependencyStampMap([
            filePath,
            ...(serializedState.i || [])
                .map(getSerializedIncludeEntryFilePath)
                .filter(Boolean)
        ]);
        const payload = {
            s: INCLUDE_PREPROCESSED_PERSISTENT_CACHE_SCHEMA,
            p: normalizeFsPath(filePath),
            h: getDefineStateSignature(options.baseDefineDecls || [], defineStateKey),
            q: String(searchPathSignature || ''),
            a: String(activeFilesSignature || ''),
            n: includeDepth,
            m: fileStamp,
            x: serializeDependencyStamps(dependencyStamps),
            r: serializedState
        };
        schedulePersistentIncludeCacheWrite(cacheFilePath, payload);
    }

    function clearPersistentIncludeDeclCache() {
        const cacheDir = getPersistentIncludeDeclCacheDirectory({ ignoreEnabled: true });
        if (!cacheDir || path.basename(cacheDir) !== INCLUDE_DECL_PERSISTENT_CACHE_DIR_NAME) {
            return Promise.resolve(false);
        }
        const root = path.resolve(String(persistentIncludeDeclCacheRoot || '').trim());
        const resolvedCacheDir = path.resolve(cacheDir);
        const relativePath = path.relative(root, resolvedCacheDir);
        const isInsideRoot = relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
        if (!isInsideRoot) return Promise.resolve(false);

        return fs.promises.readdir(cacheDir, { withFileTypes: true })
            .then(async entries => {
                const jsonFiles = (entries || [])
                    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
                    .map(entry => path.join(cacheDir, entry.name));
                await Promise.all(jsonFiles.map(filePath => fs.promises.unlink(filePath).catch(() => {})));
                await fs.promises.rmdir(cacheDir).catch(error => {
                    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
                });
                return true;
            })
            .catch(error => error?.code === 'ENOENT');
    }

    function prunePersistentIncludeDeclCache(options = {}) {
        const cacheDir = getPersistentIncludeDeclCacheDirectory();
        if (!cacheDir || persistentIncludeDeclCachePruneScheduled) return;
        const now = Date.now();
        if (
            options.force !== true &&
            now - lastPersistentIncludeDeclCachePruneAt < PERSISTENT_INCLUDE_DECL_CACHE_PRUNE_INTERVAL_MS
        ) {
            return;
        }
        lastPersistentIncludeDeclCachePruneAt = now;
        persistentIncludeDeclCachePruneScheduled = true;

        fs.promises.readdir(cacheDir, { withFileTypes: true })
            .then(async entries => {
                const files = [];
                for (const entry of entries || []) {
                    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
                    const fullPath = path.join(cacheDir, entry.name);
                    try {
                        const stat = await fs.promises.stat(fullPath);
                        files.push({
                            fullPath,
                            size: stat.size,
                            mtimeMs: stat.mtimeMs
                        });
                    } catch {
                        // Ignore files that disappeared while pruning.
                    }
                }

                const deletePaths = new Set();
                const freshFiles = [];
                for (const file of files) {
                    if (now - file.mtimeMs > PERSISTENT_INCLUDE_DECL_CACHE_MAX_AGE_MS) {
                        deletePaths.add(file.fullPath);
                    } else {
                        freshFiles.push(file);
                    }
                }

                freshFiles.sort((left, right) => right.mtimeMs - left.mtimeMs);
                let keptCount = 0;
                let keptBytes = 0;
                const maxCacheBytes = getPersistentIncludeDeclCacheMaxBytes();
                for (const file of freshFiles) {
                    keptCount++;
                    keptBytes += file.size;
                    if (
                        keptCount > PERSISTENT_INCLUDE_DECL_CACHE_MAX_FILES ||
                        keptBytes > maxCacheBytes
                    ) {
                        deletePaths.add(file.fullPath);
                    }
                }

                await Promise.all([...deletePaths].map(fullPath =>
                    fs.promises.unlink(fullPath).catch(() => {})
                ));
            })
            .catch(() => {})
            .finally(() => {
                persistentIncludeDeclCachePruneScheduled = false;
            });
    }

    return {
        clearPersistentIncludeDeclCache,
        prunePersistentIncludeDeclCache,
        readPersistentActiveIncludeDeclCache,
        readPersistentIncludeDeclCache,
        readPersistentIncludePreprocessedState,
        writePersistentActiveIncludeDeclCache,
        writePersistentIncludeDeclCache,
        writePersistentIncludePreprocessedState
    };
}

module.exports = { createIncludePersistentCache };
