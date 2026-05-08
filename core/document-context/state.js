const { getDefineDeclsSignature } = require('../utils/signature');

function createDocumentContextStateCore(deps) {
    const {
        vscode,
        fs,
        normalizeFsPath,
        documentContextFileLru,
        includeDocumentModelWarmCache,
        includeFileTextCache,
        dependencyFreshnessState,
        getDocumentContextCacheFileLimit,
        clearDocumentContextCacheForFile
    } = deps;
    const fileStampCache = new Map();
    const defineStateKeyCache = new WeakMap();
    const FILE_STAMP_CACHE_TTL_MS = 250;
    const safeDependencyFreshnessState = dependencyFreshnessState || {
        version: 1,
        checks: new WeakMap()
    };
    const normalizeIncludeContent = content => String(content || '').replace(/\\\r?\n/g, ' ');
    const getOpenDocument = filePath => {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return null;
        const openDocs = vscode?.workspace?.textDocuments || [];
        for (const doc of openDocs) {
            if (normalizeFsPath(doc?.fileName) === normalized) {
                return doc;
            }
        }
        return null;
    };
    const cloneDefineDecls = (defineDecls = []) =>
        defineDecls.map(item => ({ ...item }));

    const getDefineStateKey = (defineDecls = []) => {
        const count = Array.isArray(defineDecls) ? defineDecls.length : 0;
        if (count === 0) return '';
        const cached = defineStateKeyCache.get(defineDecls);
        if (cached != null) return cached;

        const key = getDefineDeclsSignature(defineDecls);
        defineStateKeyCache.set(defineDecls, key);
        return key;
    };

    const touchDocumentContextCacheFile = filePath => {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return;
        documentContextFileLru.delete(normalized);
        documentContextFileLru.set(normalized, true);
    };

    const pruneDocumentContextCache = activeFilePath => {
        const fileLimit = getDocumentContextCacheFileLimit();
        if (fileLimit === 0) return;

        const protectedPath = normalizeFsPath(activeFilePath);
        touchDocumentContextCacheFile(protectedPath);
        while (documentContextFileLru.size > fileLimit) {
            const oldestFilePath = documentContextFileLru.keys().next().value;
            if (!oldestFilePath) break;
            if (oldestFilePath === protectedPath && documentContextFileLru.size > 1) {
                documentContextFileLru.delete(oldestFilePath);
                documentContextFileLru.set(oldestFilePath, true);
                continue;
            }
            clearDocumentContextCacheForFile(oldestFilePath);
        }
    };

    const getFileStamp = filePath => {
        const normalized = normalizeFsPath(filePath);
        const openDocument = getOpenDocument(filePath);
        if (openDocument) {
            return {
                kind: 'document',
                version: openDocument.version
            };
        }
        const now = Date.now();
        const cachedEntry = normalized ? fileStampCache.get(normalized) : null;
        if (cachedEntry && (now - cachedEntry.at) <= FILE_STAMP_CACHE_TTL_MS) {
            return cachedEntry.stamp;
        }
        try {
            const stat = fs.statSync(filePath);
            const stamp = {
                mtimeMs: stat.mtimeMs,
                size: stat.size
            };
            if (normalized) {
                fileStampCache.set(normalized, { stamp, at: now });
            }
            return stamp;
        } catch {
            if (normalized) {
                fileStampCache.set(normalized, { stamp: null, at: now });
            }
            return null;
        }
    };

    const readNormalizedFileContent = (filePath, precomputedStamp = undefined) => {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return null;
        const stamp = precomputedStamp === undefined
            ? getFileStamp(filePath)
            : precomputedStamp;
        if (!stamp) {
            includeFileTextCache.delete(normalized);
            return null;
        }
        const cachedEntry = includeFileTextCache.get(normalized);
        if (cachedEntry && isSameFileStamp(cachedEntry.stamp, stamp)) {
            return cachedEntry.content;
        }
        try {
            const openDocument = getOpenDocument(filePath);
            const sourceText = openDocument
                ? openDocument.getText()
                : fs.readFileSync(filePath, 'utf8');
            const content = normalizeIncludeContent(sourceText);
            includeFileTextCache.set(normalized, { stamp, content });
            return content;
        } catch {
            includeFileTextCache.delete(normalized);
            return null;
        }
    };

    const clearIncludeFileTextCacheForFile = filePath => {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return;
        includeFileTextCache.delete(normalized);
    };

    const invalidateFileStamp = filePath => {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return;
        fileStampCache.delete(normalized);
    };

    const isSameFileStamp = (left, right) => {
        if (!left || !right) return false;
        if ((left.kind || '') !== (right.kind || '')) return false;
        if (left.kind === 'document') {
            return left.version === right.version;
        }
        return left.mtimeMs === right.mtimeMs && left.size === right.size;
    };

    const touchWarmedIncludeDocument = filePath => {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return false;
        const stamp = getFileStamp(filePath);
        const cachedStamp = includeDocumentModelWarmCache.get(normalized);
        if (isSameFileStamp(cachedStamp, stamp)) return true;
        if (stamp) includeDocumentModelWarmCache.set(normalized, stamp);
        else includeDocumentModelWarmCache.delete(normalized);
        return false;
    };

    const buildDependencyStampMap = filePaths => {
        const stampMap = new Map();
        for (const filePath of filePaths || []) {
            const normalized = normalizeFsPath(filePath);
            if (!normalized || stampMap.has(normalized)) continue;
            stampMap.set(normalized, getFileStamp(filePath));
        }
        safeDependencyFreshnessState.checks.set(stampMap, {
            version: safeDependencyFreshnessState.version,
            result: true
        });
        return stampMap;
    };

    const bumpDependencyFreshnessVersion = filePath => {
        if (filePath) invalidateFileStamp(filePath);
        safeDependencyFreshnessState.version++;
    };
    const getDependencyFreshnessVersion = () => safeDependencyFreshnessState.version;

    const areDependencyStampsFresh = dependencyStamps => {
        if (!(dependencyStamps instanceof Map)) return false;
        const cachedCheck = safeDependencyFreshnessState.checks.get(dependencyStamps);
        if (cachedCheck && cachedCheck.version === safeDependencyFreshnessState.version) {
            return cachedCheck.result;
        }
        for (const [normalizedPath, cachedStamp] of dependencyStamps.entries()) {
            const currentStamp = getFileStamp(normalizedPath);
            if (!isSameFileStamp(cachedStamp, currentStamp)) {
                safeDependencyFreshnessState.checks.set(dependencyStamps, {
                    version: safeDependencyFreshnessState.version,
                    result: false
                });
                return false;
            }
        }
        safeDependencyFreshnessState.checks.set(dependencyStamps, {
            version: safeDependencyFreshnessState.version,
            result: true
        });
        return true;
    };

    return {
        cloneDefineDecls,
        getDefineStateKey,
        touchDocumentContextCacheFile,
        pruneDocumentContextCache,
        getFileStamp,
        readNormalizedFileContent,
        clearIncludeFileTextCacheForFile,
        invalidateFileStamp,
        isSameFileStamp,
        touchWarmedIncludeDocument,
        buildDependencyStampMap,
        bumpDependencyFreshnessVersion,
        getDependencyFreshnessVersion,
        areDependencyStampsFresh
    };
}

module.exports = { createDocumentContextStateCore };
