// Pawn include/path resolution belongs to the document-context subsystem because it
// feeds preprocessing, active include tracking, and include declaration caches.
const crypto = require('crypto');
const {
    getDefineStateSignature,
    getIncludeEntriesSignatureHash: buildIncludeEntriesSignatureHash
} = require('../utils/signature');
const { createUtilityCore } = require('../utils');

const { normalizeExtensionList: defaultNormalizeExtensionList } = createUtilityCore();

function createDocumentIncludeSystem(deps) {
    const {
        vscode,
        fs,
        path,
        getGlobalIncludePaths,
        getProjectLocalIncludePaths,
        getIncludeFileExtensions,
        normalizeFsPath,
        resolvedIncludePathCache,
        searchPathCache,
        projectIncludeSourceCache,
        preprocessPawnContent,
        withCtrlCharForContent,
        stripLineComment,
        stripCommentsFromLines,
        getIncludeNameFromLine,
        getIncludePreprocessedStateKey,
        getIncludeDeclCacheKey,
        getActiveIncludeDeclsCacheKey,
        getDefineStateKey,
        includeFileDecls,
        getFileStamp,
        readNormalizedFileContent,
        isSameFileStamp,
        getFileSnapshot,
        getCtrlCharStateForContent,
        computeLineDepths,
        extractDocs,
        parseEnumBlock,
        isPotentialEnumDeclarationLine,
        isPotentialDeclarationStartLine,
        collectDeclarationText,
        parseDeclLine,
        collectActiveDefineDecls,
        activeIncludeDeclsCache,
        areDependencyStampsFresh,
        buildDependencyStampMap,
        normalizeExtensionList = defaultNormalizeExtensionList,
        persistentIncludeDeclCacheRoot = '',
        persistentIncludeDeclCacheMaxBytes = 24 * 1024 * 1024
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
    const INCLUDE_DECL_COMPACT_KEYS = [
        'name',
        'args',
        'macroStyle',
        'macroIndexer',
        'type',
        'typeTag',
        'dims',
        'file',
        'filePath',
        'lineNumber',
        'value',
        'enumName',
        'enumDisplayName',
        'valueDisplay',
        'startLine',
        'headerEndLine',
        'singleStatementBodyLine',
        'modifiers',
        'deprecated',
        'deprecatedMessage'
    ];
    const DEFINE_DECL_COMPACT_KEYS = [
        'name',
        'args',
        'macroStyle',
        'macroIndexer',
        'type',
        'value',
        'deprecated',
        'deprecatedMessage'
    ];
    const INCLUDE_DECL_COMPACT_SIGNATURE = INCLUDE_DECL_COMPACT_KEYS.join('|');
    let lastPersistentIncludeDeclCachePruneAt = 0;
    let persistentIncludeDeclCachePruneScheduled = false;
    const PRECOMPUTED_DECL_NAME_BUCKETS = '__pawnDeclNameBuckets';
    const PRECOMPUTED_VARIABLE_NAME_BUCKETS = '__pawnVariableNameBuckets';
    const directoryFileBaseNameCache = new Map();
    const includeSourceKindCache = new Map();
    const INCLUDE_SOURCE_KIND_CACHE_TTL_MS = 250;
    const DEFAULT_INCLUDE_FILE_EXTENSIONS = ['.inc', '.inl'];

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

    function getSearchPathSignature(filePath = '') {
        const searchPathSignature = (getSearchPaths(filePath) || [])
            .map(sourcePath => normalizeFsPath(sourcePath))
            .filter(Boolean)
            .join('|');
        return `${searchPathSignature}::ext:${getIncludeResolutionExtensionSignature()}`;
    }

    function getSearchPathCacheSettingsSignature() {
        const projectHintsSignature = (getProjectLocalIncludePaths() || [])
            .map(value => String(value || '').trim())
            .join('|');
        const globalPathsSignature = (getGlobalIncludePaths() || [])
            .map(value => String(value || '').trim())
            .join('|');
        return [
            `project:${projectHintsSignature}`,
            `global:${globalPathsSignature}`,
            `ext:${getIncludeResolutionExtensionSignature()}`
        ].join('::');
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

    function getActiveFilesSignature(activeFiles) {
        if (!(activeFiles instanceof Set)) return '';
        return [...activeFiles]
            .map(filePath => normalizeFsPath(filePath))
            .filter(Boolean)
            .sort()
            .join('|');
    }

    function serializeDependencyStamps(dependencyStamps) {
        if (!(dependencyStamps instanceof Map)) return [];
        return [...dependencyStamps.entries()].map(([filePath, stamp]) => [filePath, stamp]);
    }

    function deserializeDependencyStamps(serializedStamps = []) {
        if (!Array.isArray(serializedStamps)) return null;
        const stamps = new Map();
        for (const item of serializedStamps) {
            if (!Array.isArray(item) || item.length < 2) return null;
            const normalizedPath = normalizeFsPath(item[0]);
            if (!normalizedPath) return null;
            stamps.set(normalizedPath, item[1]);
        }
        return stamps;
    }

    function isEmptyCompactValue(value) {
        return value === undefined ||
            value === null ||
            value === '' ||
            (Array.isArray(value) && value.length === 0);
    }

    function serializeCompactObject(source, keys) {
        const values = keys.map(key => {
            const value = source?.[key];
            return Array.isArray(value) ? [...value] : value;
        });
        while (values.length && isEmptyCompactValue(values[values.length - 1])) {
            values.pop();
        }
        return values;
    }

    function reviveCompactObject(serialized, keys) {
        if (!Array.isArray(serialized)) {
            return serialized && typeof serialized === 'object' ? { ...serialized } : {};
        }
        const revived = {};
        for (let index = 0; index < serialized.length && index < keys.length; index++) {
            const value = serialized[index];
            if (value === undefined || value === null || value === '') continue;
            revived[keys[index]] = Array.isArray(value) ? [...value] : value;
        }
        return revived;
    }

    function serializeIncludeDecl(decl) {
        if (!decl || typeof decl !== 'object') return null;
        return serializeCompactObject(decl, INCLUDE_DECL_COMPACT_KEYS);
    }

    function serializeIncludeDecls(decls = []) {
        return (decls || []).map(serializeIncludeDecl).filter(Boolean);
    }

    function serializeDefineDecl(decl) {
        if (!decl || typeof decl !== 'object') return null;
        const serialized = serializeCompactObject(decl, DEFINE_DECL_COMPACT_KEYS);
        return serialized[0] ? serialized : null;
    }

    function serializeDefineDecls(defineDecls = []) {
        return (defineDecls || []).map(serializeDefineDecl).filter(Boolean);
    }

    function reviveDefineDecl(serialized) {
        const revived = reviveCompactObject(serialized, DEFINE_DECL_COMPACT_KEYS);
        return revived.name ? revived : null;
    }

    function reviveDefineDecls(defineDecls = []) {
        return (defineDecls || []).map(reviveDefineDecl).filter(Boolean);
    }

    function areSerializedDefineDeclsEqual(left, right) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        for (let index = 0; index < left.length; index++) {
            const leftValue = left[index];
            const rightValue = right[index];
            if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
                if (!areSerializedDefineDeclsEqual(leftValue, rightValue)) return false;
            } else if (leftValue !== rightValue) {
                return false;
            }
        }
        return true;
    }

    function getSerializedDefineDeclPrefixLength(previousDecls = [], nextDecls = []) {
        const limit = Math.min(previousDecls.length, nextDecls.length);
        let index = 0;
        for (; index < limit; index++) {
            if (!areSerializedDefineDeclsEqual(previousDecls[index], nextDecls[index])) break;
        }
        return index;
    }

    function attachLazyDefineStateKey(target, defineDecls = [], initialDefineStateKey = '') {
        if (!target || typeof target !== 'object') return target;
        const initialKey = String(initialDefineStateKey || '');
        if (initialKey || !Array.isArray(defineDecls) || defineDecls.length === 0) {
            target.defineStateKey = initialKey;
            return target;
        }
        let cachedKey = '';
        Object.defineProperty(target, 'defineStateKey', {
            enumerable: true,
            configurable: true,
            get() {
                if (!cachedKey) {
                    cachedKey = getDefineStateKey(defineDecls);
                }
                Object.defineProperty(target, 'defineStateKey', {
                    enumerable: true,
                    configurable: true,
                    writable: true,
                    value: cachedKey
                });
                return cachedKey;
            }
        });
        return target;
    }

    function getStoredDefineStateKeyWithoutComputing(source) {
        if (!source || typeof source !== 'object') return '';
        const descriptor = Object.getOwnPropertyDescriptor(source, 'defineStateKey');
        return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
            ? String(descriptor.value || '')
            : '';
    }

    function createDefineStateRefTable() {
        const rows = [];
        const keyToIndex = new Map();
        const getRef = (defineDecls = [], defineStateKey = '') => {
            const serializedDecls = serializeDefineDecls(defineDecls || []);
            const signature = getDefineStateSignature(defineDecls || [], defineStateKey);
            if (!signature && serializedDecls.length === 0) return -1;
            const existing = keyToIndex.get(signature);
            if (existing !== undefined) return existing;
            const index = rows.length;
            keyToIndex.set(signature, index);
            rows.push(['', serializedDecls]);
            return index;
        };
        return { rows, getRef };
    }

    function serializeDefineStateDeltaTable(fullRows = [], baseDecls = null) {
        let previousDecls = Array.isArray(baseDecls) ? baseDecls : [];
        return (fullRows || []).map(row => {
            const defineDecls = Array.isArray(row?.[1]) ? row[1] : [];
            const prefixLength = getSerializedDefineDeclPrefixLength(previousDecls, defineDecls);
            const deltaDecls = defineDecls.slice(prefixLength);
            previousDecls = defineDecls;
            return [prefixLength, deltaDecls];
        });
    }

    function reviveDefineStateDeltaTable(serializedRefs = [], baseDefineDecls = null) {
        if (!Array.isArray(serializedRefs)) return [];
        let previousDecls = Array.isArray(baseDefineDecls) ? baseDefineDecls.slice() : [];
        return serializedRefs.map(row => {
            const prefixLength = Math.max(0, Math.min(
                previousDecls.length,
                Number.isInteger(row?.[0]) ? row[0] : 0
            ));
            const deltaDecls = reviveDefineDecls(row?.[1] || []);
            const defineDecls = previousDecls.slice(0, prefixLength).concat(deltaDecls);
            previousDecls = defineDecls;
            return attachLazyDefineStateKey({ defineDecls }, defineDecls);
        });
    }

    function serializeIncludeEntryWithDefineRefs(entry, getDefineRef) {
        if (!entry || typeof entry !== 'object') return null;
        const filePath = normalizeFsPath(entry.filePath || '');
        if (!filePath) return null;
        const defineRef = getDefineRef(entry.defineDecls || [], entry.defineStateKey || '');
        const depth = Number.isInteger(entry.depth) ? entry.depth : 0;
        const serialized = [
            String(entry.name || ''),
            entry.filePath
        ];
        if (defineRef >= 0 || depth !== 0) {
            serialized[2] = defineRef >= 0 ? defineRef : '';
        }
        if (depth !== 0) {
            serialized[3] = depth;
        }
        if (entry.rationalState?.tagName) {
            serialized[4] = [
                String(entry.rationalState.tagName || ''),
                entry.rationalState.digits | 0
            ];
        }
        return serialized;
    }

    function reviveRationalState(serialized) {
        if (!Array.isArray(serialized) || !serialized[0]) return null;
        return {
            tagName: String(serialized[0] || ''),
            digits: serialized[1] | 0
        };
    }

    function serializeIncludeEntries(includeEntries = [], getDefineRef) {
        return (includeEntries || [])
            .map(entry => serializeIncludeEntryWithDefineRefs(entry, getDefineRef))
            .filter(Boolean);
    }

    function reviveIncludeEntry(serialized, defineRefTable = null) {
        if (!Array.isArray(serialized)) return null;
        const filePath = serialized[1] || '';
        if (Array.isArray(defineRefTable)) {
            const defineRef = Number.isInteger(serialized[2]) ? defineRefTable[serialized[2]] : null;
            const entry = {
                name: String(serialized[0] || ''),
                filePath,
                depth: Number.isInteger(serialized[3]) ? serialized[3] : 0,
                rationalState: reviveRationalState(serialized[4]),
                defineDecls: defineRef?.defineDecls || []
            };
            return attachLazyDefineStateKey(
                entry,
                entry.defineDecls,
                getStoredDefineStateKeyWithoutComputing(defineRef)
            );
        }
        return {
            name: String(serialized[0] || ''),
            filePath,
            defineStateKey: String(serialized[2] || ''),
            depth: Number.isInteger(serialized[3]) ? serialized[3] : 0,
            defineDecls: reviveDefineDecls(serialized[4] || []),
            rationalState: reviveRationalState(serialized[5])
        };
    }

    function getSerializedIncludeEntryFilePath(serialized) {
        return Array.isArray(serialized)
            ? serialized[1]
            : '';
    }

    function serializePreprocessedState(state, baseDefineDecls = null) {
        if (!state || typeof state !== 'object') return null;
        const defineRefs = createDefineStateRefTable();
        const serializedBaseDefineDecls = Array.isArray(baseDefineDecls)
            ? serializeDefineDecls(baseDefineDecls)
            : null;
        const serialized = {
            c: String(state.content || ''),
            q: state.rationalState?.tagName
                ? [
                    String(state.rationalState.tagName || ''),
                    state.rationalState.digits | 0
                ]
                : null,
            d: Array.isArray(state.directiveCandidateLines)
                ? state.directiveCandidateLines.filter(Number.isInteger)
                : [],
            i: serializeIncludeEntries(state.includeEntries || [], defineRefs.getRef)
        };
        const ownDefineRef = defineRefs.getRef(state.defineDecls || [], state.defineStateKey || '');
        if (defineRefs.rows.length) {
            serialized.u = serializeDefineStateDeltaTable(defineRefs.rows, serializedBaseDefineDecls);
            if (serializedBaseDefineDecls) serialized.b = 1;
        }
        if (ownDefineRef >= 0) serialized.r = ownDefineRef;
        return serialized;
    }

    function revivePreprocessedState(serializedState, baseDefineDecls = null) {
        if (!serializedState || typeof serializedState !== 'object') return null;
        const content = String(serializedState.c ?? '');
        if (serializedState.b && !Array.isArray(baseDefineDecls)) return null;
        const defineRefTable = Array.isArray(serializedState.u)
            ? reviveDefineStateDeltaTable(serializedState.u, serializedState.b ? baseDefineDecls : null)
            : null;
        const ownDefineRef = defineRefTable && Number.isInteger(serializedState.r)
            ? defineRefTable[serializedState.r]
            : null;
        const defineDecls = defineRefTable
            ? (ownDefineRef?.defineDecls || [])
            : [];
        const defineStateKey = defineRefTable
            ? getStoredDefineStateKeyWithoutComputing(ownDefineRef)
            : '';
        const revivedState = {
            content,
            rawLines: content.split(/\r?\n/),
            rationalState: reviveRationalState(serializedState.q),
            directiveCandidateLines: Array.isArray(serializedState.d)
                ? serializedState.d.filter(Number.isInteger)
                : [],
            includeEntries: Array.isArray(serializedState.i)
                ? serializedState.i
                    .map(entry => reviveIncludeEntry(entry, defineRefTable))
                    .filter(entry => entry && normalizeFsPath(entry.filePath))
                : [],
            defineDecls: defineRefTable ? defineDecls : []
        };
        return attachLazyDefineStateKey(revivedState, revivedState.defineDecls, defineStateKey || '');
    }

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
            return attachIncludeDeclIndexes(decls, revived.nameBuckets, revived.variableBuckets);
        }
        const built = buildIncludeDeclIndexes(decls);
        return attachIncludeDeclIndexes(decls, built.nameBuckets, built.variableBuckets);
    }

    function getIncludeDeclEnumKey(decl, fallbackFilePath = '') {
        const name = String(decl?.enumName || decl?.enumDisplayName || decl?.name || '');
        if (!name) return '';
        return `${normalizeFsPath(decl?.filePath || fallbackFilePath)}::${name}`;
    }

    function attachLazyIncludeDocsByDeclFile(decls, fallbackFilePath = '') {
        if (!Array.isArray(decls)) return decls;
        const groups = new Map();
        for (const decl of decls) {
            if (!decl || typeof decl !== 'object') continue;
            const resolvedFilePath = decl.filePath || fallbackFilePath;
            const key = normalizeFsPath(resolvedFilePath);
            if (!key) continue;
            const group = groups.get(key);
            if (group) group.push(decl);
            else groups.set(key, [decl]);
        }
        for (const group of groups.values()) {
            attachLazyIncludeDocs(group, group[0]?.filePath || fallbackFilePath);
        }
        return decls;
    }

    function reviveIncludeDecls(serializedDecls = [], filePath = '', options = {}) {
        if (!Array.isArray(serializedDecls)) return [];
        const decls = serializedDecls.map(item => {
            const decl = reviveCompactObject(item, INCLUDE_DECL_COMPACT_KEYS);
            return {
                ...decl,
                modifiers: Array.isArray(decl.modifiers) ? [...decl.modifiers] : []
            };
        });
        const enumDeclByName = new Map();
        for (const decl of decls) {
            if (decl?.type !== 'enum') continue;
            const enumKey = getIncludeDeclEnumKey(decl, filePath);
            if (!enumKey || enumDeclByName.has(enumKey)) continue;
            decl.enumMembers = [];
            enumDeclByName.set(enumKey, decl);
        }
        for (const decl of decls) {
            if (decl?.type !== 'enum-item') continue;
            const enumDecl = enumDeclByName.get(getIncludeDeclEnumKey(decl, filePath));
            if (enumDecl) enumDecl.enumMembers.push(decl);
        }
        if (options.groupDocsByDeclFile) {
            attachLazyIncludeDocsByDeclFile(decls, filePath);
        } else {
            attachLazyIncludeDocs(decls, filePath);
        }
        return options.attachIndexes
            ? attachIncludeDeclIndexesFromSerializedOrBuild(decls, options.indexes)
            : decls;
    }

    function attachLazyIncludeDocs(decls, filePath = '') {
        if (!Array.isArray(decls) || typeof extractDocs !== 'function') return decls;
        let snapshot = null;
        const docsByLine = new Map();
        const getSnapshot = () => {
            if (snapshot !== null) return snapshot;
            const content = readNormalizedFileContent(filePath);
            snapshot = content == null ? false : getFileSnapshot(filePath, content);
            return snapshot;
        };
        const getDocsForLine = lineNumber => {
            if (!Number.isInteger(lineNumber) || lineNumber < 0) return '';
            if (docsByLine.has(lineNumber)) return docsByLine.get(lineNumber);
            const fileSnapshot = getSnapshot();
            const value = fileSnapshot
                ? extractDocs(fileSnapshot.rawLines || [], lineNumber, {
                    includeInline: true,
                    lineCtrlChars: fileSnapshot.lineCtrlChars || []
                })
                : '';
            docsByLine.set(lineNumber, value || '');
            return value || '';
        };
        const enumDeclLineByName = new Map();
        for (const decl of decls) {
            if (decl?.type !== 'enum') continue;
            const enumKey = String(decl.enumName || decl.enumDisplayName || decl.name || '');
            if (enumKey && !enumDeclLineByName.has(enumKey)) {
                enumDeclLineByName.set(enumKey, decl.lineNumber);
            }
        }
        for (const decl of decls) {
            if (!decl || typeof decl !== 'object') continue;
            if (!Object.prototype.hasOwnProperty.call(decl, 'docs')) {
                Object.defineProperty(decl, 'docs', {
                    enumerable: true,
                    configurable: true,
                    get() {
                        const value = getDocsForLine(decl.lineNumber);
                        Object.defineProperty(decl, 'docs', {
                            enumerable: true,
                            configurable: true,
                            writable: true,
                            value
                        });
                        return value;
                    }
                });
            }
            if (
                decl.type === 'enum-item' &&
                !Object.prototype.hasOwnProperty.call(decl, 'enumDocs')
            ) {
                Object.defineProperty(decl, 'enumDocs', {
                    enumerable: true,
                    configurable: true,
                    get() {
                        const value = getDocsForLine(enumDeclLineByName.get(String(decl.enumName || '')));
                        Object.defineProperty(decl, 'enumDocs', {
                            enumerable: true,
                            configurable: true,
                            writable: true,
                            value
                        });
                        return value;
                    }
                });
            }
        }
        return decls;
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

    function attachIncludeDeclIndexes(decls, nameBuckets, variableBuckets) {
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

    function mergeUniqueSources(...sourceLists) {
        const seen = new Set();
        const results = [];
        for (const sourceList of sourceLists) {
            for (const sourcePath of sourceList || []) {
                if (!sourcePath || !fs.existsSync(sourcePath)) continue;
                const normalized = normalizeFsPath(sourcePath);
                if (!normalized || seen.has(normalized)) continue;
                seen.add(normalized);
                results.push(path.resolve(sourcePath));
            }
        }
        return results;
    }

    function buildProjectIncludeCacheKey(rootPath = '', hints = []) {
        return [
            normalizeFsPath(rootPath),
            hints.map(h => h.toLowerCase()).join('|'),
            getIncludeResolutionExtensionSignature()
        ].join('::');
    }

    function hasFreshDiscoveredSources(cacheEntry) {
        return !!(
            cacheEntry &&
            cacheEntry.dirty !== true &&
            Array.isArray(cacheEntry.discoveredSources) &&
            Array.isArray(cacheEntry.allSources)
        );
    }

    function clearRootScopedSearchPathCaches(rootPath = '') {
        const normalizedRoot = normalizeFsPath(rootPath);
        if (!normalizedRoot) return;
        for (const cacheKey of searchPathCache.keys()) {
            if (cacheKey.startsWith(`${normalizedRoot}::`)) {
                searchPathCache.delete(cacheKey);
            }
        }
        resolvedIncludePathCache.clear();
    }

    function resolveConfiguredPath(rawPath, docFilePath = '') {
        const value = String(rawPath || '').trim();
        if (!value) return '';

        const candidates = [];
        if (path.isAbsolute(value)) {
            candidates.push(value);
        } else {
            for (const folder of vscode.workspace.workspaceFolders || []) {
                candidates.push(path.join(folder.uri.fsPath, value));
            }
            if (!(vscode.workspace.workspaceFolders || []).length && docFilePath) {
                candidates.push(path.join(path.dirname(docFilePath), value));
            }
        }

        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
        }
        return '';
    }

    function getConfiguredGlobalIncludeSources(docFilePath = '') {
        const seen = new Set();
        const results = [];
        for (const rawPath of getGlobalIncludePaths() || []) {
            const resolved = resolveConfiguredPath(rawPath, docFilePath);
            if (!resolved) continue;
            const normalized = normalizeFsPath(resolved);
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            results.push(resolved);
        }
        return results;
    }

    function getConfiguredProjectIncludeHints() {
        const hints = getProjectLocalIncludePaths();
        const source = Array.isArray(hints) && hints.length ? hints : ['include'];
        return source
            .map(v => String(v || '').trim())
            .filter(Boolean);
    }

    function getConfiguredIncludeFileExtensions() {
        const rawExtensions = getIncludeFileExtensions();
        const normalized = normalizeExtensionList(rawExtensions, DEFAULT_INCLUDE_FILE_EXTENSIONS, { useFallbackWhenEmpty: true });
        return normalized.length ? [...new Set(normalized)] : DEFAULT_INCLUDE_FILE_EXTENSIONS;
    }

    function getIncludeResolutionExtensions() {
        return getConfiguredIncludeFileExtensions();
    }

    function getIncludeResolutionExtensionSignature() {
        return getIncludeResolutionExtensions().join('|');
    }

    function hasAllowedIncludeExtension(filePath = '') {
        const ext = path.extname(String(filePath || '')).toLowerCase();
        return !!ext && getConfiguredIncludeFileExtensions().includes(ext);
    }

    function getProjectRootForFile(docFilePath = '') {
        if (docFilePath) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(docFilePath));
            if (workspaceFolder?.uri?.fsPath) return workspaceFolder.uri.fsPath;
            return path.dirname(docFilePath);
        }
        return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
    }

    function buildProjectIncludeIndexFromRoot(rootPath = '', hints = [], exactSources = []) {
        const emptyIndex = {
            discoveredSources: [],
            allSources: mergeUniqueSources(exactSources),
            includeIndex: new Map()
        };
        if (!rootPath || !fs.existsSync(rootPath)) return emptyIndex;

        const discoveredSources = [];
        const allSources = mergeUniqueSources(exactSources);
        const includeIndex = new Map();
        const includeExtensions = getIncludeResolutionExtensions();
        const allowedExtensions = new Set(includeExtensions);
        const extensionPriorityByExt = new Map(includeExtensions.map((ext, index) => [ext, index]));
        const seen = new Set(allSources.map(sourcePath => normalizeFsPath(sourcePath)));
        const sourcePriorityByRoot = new Map();
        allSources.forEach((sourcePath, index) => {
            const normalized = normalizeFsPath(sourcePath);
            if (normalized && !sourcePriorityByRoot.has(normalized)) {
                sourcePriorityByRoot.set(normalized, index);
            }
        });
        const hintBaseNames = new Set((hints || []).map(h => path.basename(h)).filter(Boolean));
        const ignoredDirs = new Set(['.git', '.hg', '.svn', 'node_modules']);
        const exactDirSet = new Set();
        const exactFileSources = [];
        for (const sourcePath of exactSources || []) {
            try {
                const stat = fs.statSync(sourcePath);
                if (stat.isDirectory()) {
                    exactDirSet.add(normalizeFsPath(sourcePath));
                } else if (stat.isFile()) {
                    exactFileSources.push(path.resolve(sourcePath));
                }
            } catch {
                // Ignore unreadable configured include sources.
            }
        }
        const addDiscoveredIncludeSource = sourcePath => {
            if (!sourcePath || !fs.existsSync(sourcePath)) return;
            const normalized = normalizeFsPath(sourcePath);
            if (!normalized || seen.has(normalized)) return;
            seen.add(normalized);
            const resolved = path.resolve(sourcePath);
            sourcePriorityByRoot.set(normalized, allSources.length);
            discoveredSources.push(resolved);
            allSources.push(resolved);
        };
        const indexCandidate = (sourceRoot, filePath) => {
            if (!sourceRoot || !filePath) return;
            const resolvedFilePath = path.resolve(filePath);
            const fileExt = path.extname(resolvedFilePath).toLowerCase();
            if (!allowedExtensions.has(fileExt)) return;
            const fileExtensionPriority = extensionPriorityByExt.get(fileExt) ?? Number.MAX_SAFE_INTEGER;
            const normalizedFilePath = normalizeFsPath(resolvedFilePath);
            if (!normalizedFilePath) return;
            const requestKeys = new Set();
            const fileName = path.basename(resolvedFilePath);
            const parsed = path.parse(fileName);
            const normalizedRelative = normalizeFsPath(path.relative(sourceRoot, resolvedFilePath)).replace(/^\.\//, '');
            const normalizedBaseName = normalizeFsPath(parsed.name);
            const normalizedFileName = normalizeFsPath(fileName);
            if (normalizedRelative) {
                requestKeys.add(normalizedRelative);
                if (parsed.ext) {
                    requestKeys.add(normalizedRelative.slice(0, -parsed.ext.length));
                }
            }
            if (normalizedFileName) requestKeys.add(normalizedFileName);
            if (normalizedBaseName) requestKeys.add(normalizedBaseName);

            const sourcePriority = sourcePriorityByRoot.get(normalizeFsPath(sourceRoot)) ?? Number.MAX_SAFE_INTEGER;
            for (const requestKey of requestKeys) {
                if (!requestKey) continue;
                const existing = includeIndex.get(requestKey);
                if (existing) {
                    const existingSourcePriority = existing.sourcePriority ?? existing.priority ?? Number.MAX_SAFE_INTEGER;
                    const existingExtensionPriority = existing.extensionPriority ?? Number.MAX_SAFE_INTEGER;
                    if (
                        existingSourcePriority < sourcePriority ||
                        (
                            existingSourcePriority === sourcePriority &&
                            existingExtensionPriority <= fileExtensionPriority
                        )
                    ) {
                        continue;
                    }
                }
                includeIndex.set(requestKey, {
                    filePath: resolvedFilePath,
                    priority: sourcePriority,
                    sourcePriority,
                    extensionPriority: fileExtensionPriority
                });
            }
        };
        const walk = (currentDir, activeSourceRoot = '') => {
            let entries = [];
            try {
                entries = fs.readdirSync(currentDir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    if (ignoredDirs.has(entry.name)) continue;
                    const normalizedDir = normalizeFsPath(fullPath);
                    const nextSourceRoot = activeSourceRoot || (
                        exactDirSet.has(normalizedDir) || hintBaseNames.has(entry.name)
                            ? fullPath
                            : ''
                    );
                    if (nextSourceRoot && nextSourceRoot === fullPath) {
                        addDiscoveredIncludeSource(fullPath);
                    }
                    walk(fullPath, nextSourceRoot);
                    continue;
                }
                if (entry.isFile() && activeSourceRoot) {
                    indexCandidate(activeSourceRoot, fullPath);
                }
            }
        };
        for (const exactFileSource of exactFileSources) {
            const sourceRoot = path.dirname(exactFileSource);
            indexCandidate(sourceRoot, exactFileSource);
        }
        walk(rootPath, exactDirSet.has(normalizeFsPath(rootPath)) ? rootPath : '');
        return {
            discoveredSources,
            allSources,
            includeIndex
        };
    }

    function ensureProjectIncludeCacheEntry(rootPath = '', options = {}) {
        if (!rootPath || !fs.existsSync(rootPath)) return null;
        const hints = getConfiguredProjectIncludeHints();
        const cacheKey = buildProjectIncludeCacheKey(rootPath, hints);
        let cacheEntry = projectIncludeSourceCache.get(cacheKey) || null;
        if (!cacheEntry) {
            const exactSources = [];
            for (const hint of hints) {
                const exactPath = path.isAbsolute(hint) ? hint : path.join(rootPath, hint);
                if (exactPath && fs.existsSync(exactPath)) {
                    exactSources.push(path.resolve(exactPath));
                }
            }
            cacheEntry = {
                exactSources: mergeUniqueSources(exactSources),
                discoveredSources: [],
                allSources: [],
                includeIndex: new Map(),
                dirty: true
            };
            projectIncludeSourceCache.set(cacheKey, cacheEntry);
        }

        if (cacheEntry.dirty !== true && options.refresh !== true) {
            return cacheEntry;
        }

        const indexState = buildProjectIncludeIndexFromRoot(rootPath, hints, cacheEntry.exactSources);
        cacheEntry.discoveredSources = indexState.discoveredSources;
        cacheEntry.allSources = indexState.allSources;
        cacheEntry.includeIndex = indexState.includeIndex;
        cacheEntry.dirty = false;
        projectIncludeSourceCache.set(cacheKey, cacheEntry);
        return cacheEntry;
    }

    function markWorkspaceIncludeSourcesDirty(docFilePath = '') {
        directoryFileBaseNameCache.clear();
        const rootPath = getProjectRootForFile(docFilePath);
        if (!rootPath) {
            for (const cacheEntry of projectIncludeSourceCache.values()) {
                cacheEntry.dirty = true;
            }
            searchPathCache.clear();
            resolvedIncludePathCache.clear();
            return;
        }
        const hints = getConfiguredProjectIncludeHints();
        const cacheKey = buildProjectIncludeCacheKey(rootPath, hints);
        const cacheEntry = projectIncludeSourceCache.get(cacheKey);
        if (cacheEntry) {
            cacheEntry.dirty = true;
            projectIncludeSourceCache.set(cacheKey, cacheEntry);
        }
        clearRootScopedSearchPathCaches(rootPath);
    }

    function collectProjectIncludeSourcesFromRoot(rootPath = '', options = {}) {
        if (!rootPath || !fs.existsSync(rootPath)) return [];
        const includeDiscovered = options.includeDiscovered !== false;
        const cacheEntry = ensureProjectIncludeCacheEntry(rootPath, {
            refresh: includeDiscovered
        });
        if (!cacheEntry) return [];

        if (!includeDiscovered) {
            return [...cacheEntry.exactSources];
        }
        return hasFreshDiscoveredSources(cacheEntry)
            ? [...cacheEntry.allSources]
            : mergeUniqueSources(cacheEntry.exactSources, cacheEntry.discoveredSources);
    }

    function collectProjectIncludeSources(docFilePath = '', options = {}) {
        return collectProjectIncludeSourcesFromRoot(getProjectRootForFile(docFilePath), options);
    }

    function getCachedProjectIncludeSourcesFromRoot(rootPath = '') {
        if (!rootPath || !fs.existsSync(rootPath)) return [];
        const cacheEntry = ensureProjectIncludeCacheEntry(rootPath, { refresh: false });
        if (!cacheEntry) return [];
        return hasFreshDiscoveredSources(cacheEntry)
            ? [...cacheEntry.allSources]
            : [...cacheEntry.exactSources];
    }

    function getCachedProjectIncludeSources(docFilePath = '') {
        return getCachedProjectIncludeSourcesFromRoot(getProjectRootForFile(docFilePath));
    }

    function warmWorkspaceIncludeSources(docFilePath = '') {
        const roots = [];
        const seen = new Set();
        for (const folder of vscode.workspace.workspaceFolders || []) {
            const rootPath = folder?.uri?.fsPath || '';
            const normalized = normalizeFsPath(rootPath);
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            roots.push(rootPath);
        }
        if (!roots.length) {
            const fallbackRoot = getProjectRootForFile(docFilePath);
            if (fallbackRoot) roots.push(fallbackRoot);
        }

        for (const rootPath of roots) {
            ensureProjectIncludeCacheEntry(rootPath, { refresh: true });
        }
    }

    function tryResolveFromProjectIncludeIndex(name, fromFilePath) {
        const rootPath = getProjectRootForFile(fromFilePath);
        const cacheEntry = ensureProjectIncludeCacheEntry(rootPath, { refresh: false });
        if (!cacheEntry || !hasFreshDiscoveredSources(cacheEntry)) return null;
        const requestKey = normalizeFsPath(String(name || '').replace(/\\/g, '/'));
        if (!requestKey) return null;
        const indexedEntry = cacheEntry.includeIndex.get(requestKey);
        const indexedPath = typeof indexedEntry === 'string'
            ? indexedEntry
            : indexedEntry?.filePath;
        return indexedPath && fs.existsSync(indexedPath)
            ? indexedPath
            : null;
    }

    function getSearchPaths(docFilePath = '') {
        const workspaceRoot = getProjectRootForFile(docFilePath);
        const fallbackBase = !(vscode.workspace.workspaceFolders || []).length && docFilePath
            ? path.dirname(docFilePath)
            : '';
        const cacheKey = [
            normalizeFsPath(workspaceRoot),
            normalizeFsPath(fallbackBase),
            getSearchPathCacheSettingsSignature()
        ].join('::');
        if (searchPathCache.has(cacheKey)) {
            return [...searchPathCache.get(cacheKey)];
        }
        const seen = new Set();
        const results = [];
        const addSearchPathSource = sourcePath => {
            if (!sourcePath || !fs.existsSync(sourcePath)) return;
            const normalized = normalizeFsPath(sourcePath);
            if (seen.has(normalized)) return;
            seen.add(normalized);
            results.push(sourcePath);
        };

        getCachedProjectIncludeSources(docFilePath).forEach(addSearchPathSource);
        getConfiguredGlobalIncludeSources(docFilePath).forEach(addSearchPathSource);
        searchPathCache.set(cacheKey, results);
        return results;
    }

    function parseRawIncludes(content) {
        const processedContent = preprocessPawnContent(content);
        return withCtrlCharForContent(processedContent, () => {
            const rawLines = processedContent.split(/\r?\n/);
            const strippedLines = processedContent.includes('/*')
                ? stripCommentsFromLines(rawLines)
                : rawLines;
            return strippedLines
                .map(line => getIncludeNameFromLine(stripLineComment(line).trim()))
                .filter(Boolean);
        });
    }

    function resolveIncludeFromBase(baseDir, name) {
        const requestedExt = path.extname(name).toLowerCase();
        if (requestedExt && !hasAllowedIncludeExtension(name)) {
            return null;
        }
        const exactPath = path.join(baseDir, name);
        if (requestedExt && fs.existsSync(exactPath)) return path.resolve(exactPath);

        if (requestedExt) return null;

        for (const ext of getIncludeResolutionExtensions()) {
            const candidatePath = path.join(baseDir, name + ext);
            if (fs.existsSync(candidatePath)) return path.resolve(candidatePath);
        }

        const relDir = path.dirname(name);
        const targetDir = relDir && relDir !== '.'
            ? path.join(baseDir, relDir)
            : baseDir;
        let targetDirStat = null;
        try {
            targetDirStat = fs.statSync(targetDir);
        } catch {
            return null;
        }
        if (!targetDirStat.isDirectory()) return null;

        const baseName = path.basename(name);
        const normalizedDir = normalizeFsPath(targetDir);
        const includeExtensions = getIncludeResolutionExtensions();
        const includeExtensionSet = new Set(includeExtensions);
        const extensionPriority = new Map(includeExtensions.map((ext, index) => [ext, index]));
        const stamp = `${Number(targetDirStat.mtimeMs || 0)}:${Number(targetDirStat.size || 0)}:${includeExtensions.join('|')}`;
        let cachedEntry = directoryFileBaseNameCache.get(normalizedDir);
        if (!cachedEntry || cachedEntry.stamp !== stamp) {
            const byBaseName = new Map();
            let entries = [];
            try {
                entries = fs.readdirSync(targetDir, { withFileTypes: true });
            } catch {
                return null;
            }
            for (const entry of entries) {
                if (!entry?.name) continue;
                let isFile = entry.isFile();
                if (!isFile && entry.isSymbolicLink?.()) {
                    try {
                        isFile = fs.statSync(path.join(targetDir, entry.name)).isFile();
                    } catch {
                        isFile = false;
                    }
                }
                if (!isFile) continue;
                const entryBaseName = path.parse(entry.name).name;
                const entryExt = path.extname(entry.name).toLowerCase();
                if (!includeExtensionSet.has(entryExt)) continue;
                const priority = extensionPriority.get(entryExt) ?? Number.MAX_SAFE_INTEGER;
                const existing = byBaseName.get(entryBaseName);
                if (!existing || priority < existing.priority) {
                    byBaseName.set(entryBaseName, { name: entry.name, priority });
                }
            }
            cachedEntry = { stamp, byBaseName };
            directoryFileBaseNameCache.set(normalizedDir, cachedEntry);
        }
        const match = cachedEntry.byBaseName.get(baseName)?.name || '';
        if (!match) {
            return null;
        }
        return path.resolve(path.join(targetDir, match));
    }

    function getIncludeSourceKind(sourcePath) {
        const normalized = normalizeFsPath(sourcePath);
        if (!normalized) return '';
        const now = Date.now();
        const cached = includeSourceKindCache.get(normalized);
        if (cached && (now - cached.at) <= INCLUDE_SOURCE_KIND_CACHE_TTL_MS) {
            return cached.kind;
        }
        let kind = '';
        try {
            const stat = fs.statSync(sourcePath);
            if (stat.isDirectory()) kind = 'directory';
            else if (stat.isFile()) kind = 'file';
        } catch {
            kind = '';
        }
        includeSourceKindCache.set(normalized, { kind, at: now });
        return kind;
    }

    function resolveConfiguredIncludeFile(filePath, name, preverifiedFile = false) {
        if (!filePath) return null;
        if (!hasAllowedIncludeExtension(filePath)) return null;
        if (!preverifiedFile) {
            if (getIncludeSourceKind(filePath) !== 'file') return null;
        }

        const fileName = path.basename(filePath);
        const requestBase = path.basename(name);
        if (!requestBase) return null;

        const requestedExt = path.extname(name).toLowerCase();
        if (requestedExt) {
            if (!hasAllowedIncludeExtension(name)) return null;
            return fileName.toLowerCase() === requestBase.toLowerCase()
                ? path.resolve(filePath)
                : null;
        }

        return path.parse(fileName).name.toLowerCase() === requestBase.toLowerCase()
            ? path.resolve(filePath)
            : null;
    }

    function resolveInclude(name, searchPaths, fromFilePath) {
        const tryResolveFromSources = (sources = [], cacheResolvedPath = true) => {
            for (const sourcePath of sources) {
                const sourceKind = getIncludeSourceKind(sourcePath);
                const full = sourceKind === 'directory'
                    ? resolveIncludeFromBase(sourcePath, name)
                    : sourceKind === 'file'
                    ? resolveConfiguredIncludeFile(sourcePath, name, true)
                    : null;
                if (!full) continue;
                if (cacheResolvedPath) {
                    resolvedIncludePathCache.set(cacheKey, full);
                }
                return full;
            }
            return null;
        };
        const cacheKey = [
            normalizeFsPath(fromFilePath),
            String(name || ''),
            searchPaths.map(normalizeFsPath).join('|'),
            getIncludeResolutionExtensionSignature()
        ].join('::');
        const cachedPath = resolvedIncludePathCache.get(cacheKey);
        if (cachedPath && getIncludeSourceKind(cachedPath) === 'file') return cachedPath;
        if (cachedPath) {
            resolvedIncludePathCache.delete(cacheKey);
        }

        if (fromFilePath) {
            const baseDir = path.dirname(fromFilePath);
            const localMatch = resolveIncludeFromBase(baseDir, name);
            if (localMatch) {
                resolvedIncludePathCache.set(cacheKey, localMatch);
                return localMatch;
            }
        }

        const indexedMatch = fromFilePath
            ? tryResolveFromProjectIncludeIndex(name, fromFilePath)
            : null;
        if (indexedMatch) {
            resolvedIncludePathCache.set(cacheKey, indexedMatch);
            return indexedMatch;
        }

        const directMatch = tryResolveFromSources(searchPaths, true);
        if (directMatch) {
            return directMatch;
        }

        if (fromFilePath) {
            const discoveredProjectSources = collectProjectIncludeSources(fromFilePath, { includeDiscovered: true })
                .filter(sourcePath => !searchPaths.some(existing => normalizeFsPath(existing) === normalizeFsPath(sourcePath)));
            const discoveredCacheKey = discoveredProjectSources.length
                ? `${cacheKey}::discovered::${discoveredProjectSources.map(normalizeFsPath).join('|')}`
                : '';
            const cachedDiscoveredPath = discoveredCacheKey
                ? resolvedIncludePathCache.get(discoveredCacheKey)
                : '';
            if (cachedDiscoveredPath && fs.existsSync(cachedDiscoveredPath)) {
                return cachedDiscoveredPath;
            }
            if (cachedDiscoveredPath && discoveredCacheKey) {
                resolvedIncludePathCache.delete(discoveredCacheKey);
            }
            const discoveredMatch = tryResolveFromSources(discoveredProjectSources, false);
            if (discoveredMatch) {
                if (discoveredCacheKey) {
                    resolvedIncludePathCache.set(discoveredCacheKey, discoveredMatch);
                }
                return discoveredMatch;
            }
        }

        return null;
    }

    function parseIncludeFile(filePath, defineDecls = [], precomputedDefineStateKey = '', preprocessedState = null) {
        const defineStateKey = precomputedDefineStateKey || getDefineStateKey(defineDecls);
        const cacheKey = getIncludeDeclCacheKey(filePath, defineDecls, defineStateKey);
        const cachedEntry = includeFileDecls.get(cacheKey) || null;
        const currentFileStamp = getFileStamp(filePath);
        const searchPathSignature = getSearchPathSignature(filePath);
        if (
            cachedEntry &&
            isSameFileStamp(cachedEntry.fileStamp, currentFileStamp) &&
            String(cachedEntry.searchPathSignature || '') === searchPathSignature &&
            cachedEntry.dependencyStamps &&
            areDependencyStampsFresh(cachedEntry.dependencyStamps)
        ) {
            return cachedEntry.decls || [];
        }
        if (cachedEntry) {
            includeFileDecls.delete(cacheKey);
        }
        const persistentEntry = readPersistentIncludeDeclCache(
            filePath,
            defineStateKey,
            currentFileStamp,
            searchPathSignature,
            defineDecls
        );
        if (persistentEntry?.decls) {
            includeFileDecls.set(cacheKey, {
                decls: persistentEntry.decls,
                fileStamp: currentFileStamp,
                searchPathSignature,
                dependencyStamps: persistentEntry.dependencyStamps
            });
            return persistentEntry.decls;
        }
        try {
            let resolvedPreprocessedState = preprocessedState;
            if (!resolvedPreprocessedState) {
                const sourceContent = readNormalizedFileContent(filePath, currentFileStamp);
                if (sourceContent == null) return [];
                const sourceSnapshot = getFileSnapshot(filePath, sourceContent);
                const sourceCtrlCharState = sourceSnapshot.ctrlCharState;
                resolvedPreprocessedState = preprocessPawnContent(sourceContent, {
                    defineDecls,
                    precomputedDefineStateKey,
                    fromFilePath: filePath,
                    searchPaths: getSearchPaths(filePath),
                    rawLines: sourceSnapshot.rawLines,
                    strippedLines: sourceCtrlCharState.strippedLines || sourceSnapshot.rawLines,
                    directiveCandidateLines: sourceCtrlCharState.directiveCandidateLines || null,
                    returnState: true
                });
            }
            const content  = resolvedPreprocessedState.content;
            const fileName = path.basename(filePath);
            const contentSnapshot = getFileSnapshot(filePath, content, {
                rawLines: resolvedPreprocessedState.rawLines
            });
            const decls = withCtrlCharForContent(content, () => {
                    const rawLines = contentSnapshot.rawLines;
                    const strippedLines = contentSnapshot.strippedLines;
                    const lineCtrlChars = contentSnapshot.lineCtrlChars;
                    const depths = contentSnapshot.lineDepths;
                    const decls    = [];
                let i = 0;
                while (i < rawLines.length) {
                    if (depths[i] !== 0) { i++; continue; }
                    if (!isPotentialDeclarationStartLine(strippedLines[i])) { i++; continue; }
                    if (isPotentialEnumDeclarationLine(strippedLines[i])) {
                        const enumBlock = parseEnumBlock(rawLines, i, filePath, fileName, lineCtrlChars, strippedLines, decls);
                        if (enumBlock) {
                            decls.push(...enumBlock.decls);
                            i = enumBlock.nextLine;
                            continue;
                        }
                    }
                    const startI = i;
                    const { text: joined, nextLine } = collectDeclarationText(rawLines, i, lineCtrlChars, strippedLines);
                    i = nextLine;
                    for (const d of parseDeclLine({ text: joined, startLine: startI }, rawLines, filePath, fileName, 'include')) {
                        if (d.type !== 'define') decls.push(d);
                    }
                }
                decls.push(...collectActiveDefineDecls(
                    rawLines,
                    filePath,
                    fileName,
                    lineCtrlChars,
                    undefined,
                    strippedLines,
                    resolvedPreprocessedState.directiveCandidateLines || null
                ));
                const dependencyStamps = buildDependencyStampMap([
                    filePath,
                    ...(resolvedPreprocessedState.includeEntries || []).map(entry => entry.filePath)
                ]);
                includeFileDecls.set(cacheKey, {
                    decls,
                    fileStamp: currentFileStamp || getFileStamp(filePath),
                    searchPathSignature,
                    dependencyStamps
                });
                writePersistentIncludeDeclCache(
                    filePath,
                    defineStateKey,
                    currentFileStamp || getFileStamp(filePath),
                    searchPathSignature,
                    decls,
                    dependencyStamps,
                    defineDecls
                );
                return decls;
            }, filePath, contentSnapshot.finalCtrlChar);
            return decls;
        } catch (err) { console.error('parseIncludeFile:', err); }
        return [];
    }

    function collectActiveIncludeEntries(docContent, searchPaths, docFilePath, preprocessedState = null) {
        const sourceSnapshot = preprocessedState ? null : getFileSnapshot(docFilePath, docContent);
        const sourceCtrlCharState = sourceSnapshot?.ctrlCharState || null;
        const resolvedPreprocessedState = preprocessedState || preprocessPawnContent(docContent, {
            fromFilePath: docFilePath,
            searchPaths,
            rawLines: sourceSnapshot?.rawLines,
            strippedLines: sourceCtrlCharState?.strippedLines,
            directiveCandidateLines: sourceCtrlCharState?.directiveCandidateLines || null,
            returnState: true
        });
        return resolvedPreprocessedState.includeEntries || [];
    }

    function getActiveDecls(docContent, searchPaths, docFilePath, preprocessedState = null) {
        const includeEntries = collectActiveIncludeEntries(docContent, searchPaths, docFilePath, preprocessedState);
        const cacheKey = getActiveIncludeDeclsCacheKey(docFilePath, includeEntries);
        const searchPathSignature = getSearchPathSignature(docFilePath);
        const cached = cacheKey ? activeIncludeDeclsCache.get(cacheKey) : null;
        if (
            cached &&
            String(cached.searchPathSignature || '') === searchPathSignature &&
            areDependencyStampsFresh(cached.dependencyStamps)
        ) {
            return cached.decls;
        }
        const includePreprocessedStates = preprocessedState?.includePreprocessedStates instanceof Map
            ? preprocessedState.includePreprocessedStates
            : null;
        const persistentEntry = readPersistentActiveIncludeDeclCache(
            docFilePath,
            includeEntries,
            searchPathSignature
        );
        if (persistentEntry?.decls) {
            if (includePreprocessedStates) {
                includePreprocessedStates.clear();
                preprocessedState.includePreprocessedStates = null;
            }
            if (cacheKey) {
                activeIncludeDeclsCache.set(cacheKey, {
                    decls: persistentEntry.decls,
                    dependencyStamps: persistentEntry.dependencyStamps,
                    searchPathSignature
                });
            }
            return persistentEntry.decls;
        }
        const decls = [];
        const nameBuckets = new Map();
        const variableBuckets = new Map();
        const pushDecl = decl => {
            if (!decl) return;
            decls.push(decl);
            if (decl.name) {
                const bucket = nameBuckets.get(decl.name);
                if (bucket) bucket.push(decl);
                else nameBuckets.set(decl.name, [decl]);
                if (decl.type === 'variable' && !variableBuckets.get(decl.name)) {
                    variableBuckets.set(decl.name, decl);
                }
            }
        };
        for (const entry of includeEntries) {
            const preparedState = includePreprocessedStates
                ? includePreprocessedStates.get(getIncludePreprocessedStateKey(entry.filePath, entry.defineStateKey, entry.defineDecls || []))
                : null;
            const parsedDecls = parseIncludeFile(entry.filePath, entry.defineDecls, entry.defineStateKey, preparedState) || [];
            for (const decl of parsedDecls) pushDecl(decl);
        }
        attachIncludeDeclIndexes(decls, nameBuckets, variableBuckets);
        if (includePreprocessedStates) {
            includePreprocessedStates.clear();
            preprocessedState.includePreprocessedStates = null;
        }

        const dependencyStamps = buildDependencyStampMap((function* () {
            for (const entry of includeEntries) yield entry?.filePath || '';
        })());
        if (cacheKey) {
            activeIncludeDeclsCache.set(cacheKey, {
                decls,
                dependencyStamps,
                searchPathSignature
            });
        }
        writePersistentActiveIncludeDeclCache(
            includeEntries,
            searchPathSignature,
            decls,
            dependencyStamps
        );

        return decls;
    }

    return {
        resolveConfiguredPath,
        getConfiguredGlobalIncludeSources,
        getConfiguredProjectIncludeHints,
        getProjectRootForFile,
        collectProjectIncludeSourcesFromRoot,
        collectProjectIncludeSources,
        getCachedProjectIncludeSourcesFromRoot,
        getCachedProjectIncludeSources,
        markWorkspaceIncludeSourcesDirty,
        warmWorkspaceIncludeSources,
        getSearchPaths,
        parseRawIncludes,
        readPersistentIncludePreprocessedState,
        writePersistentIncludePreprocessedState,
        resolveIncludeFromBase,
        resolveConfiguredIncludeFile,
        resolveInclude,
        parseIncludeFile,
        collectActiveIncludeEntries,
        getActiveDecls,
        clearPersistentIncludeDeclCache,
        prunePersistentIncludeDeclCache
    };
}

module.exports = { createDocumentIncludeSystem };
