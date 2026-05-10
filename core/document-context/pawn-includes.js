// Pawn include/path resolution belongs to the document-context subsystem because it
// feeds preprocessing, active include tracking, and include declaration caches.
const {
    getDefineStateSignature,
    getIncludeEntriesSignatureHash: buildIncludeEntriesSignatureHash
} = require('../utils/signature');
const { createUtilityCore } = require('../utils');
const { getEffectiveIncludeFileExtensions } = require('../include-extensions');
const { createIncludeCacheCodec } = require('./include-cache-codec');
const {
    attachIncludeDeclIndexesFromSerializedOrBuild,
    createIncludeDeclAccumulator,
    dedupeIncludeDecls,
    serializeIncludeDeclIndexes
} = require('./include-decl-indexes');
const { createIncludePersistentCache } = require('./include-persistent-cache');

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
    const directoryFileBaseNameCache = new Map();
    const includeSourceKindCache = new Map();
    const INCLUDE_SOURCE_KIND_CACHE_TTL_MS = 250;
    const {
        INCLUDE_DECL_COMPACT_SIGNATURE,
        deserializeDependencyStamps,
        getSerializedIncludeEntryFilePath,
        reviveIncludeDeclCompactObject,
        revivePreprocessedState,
        serializeDependencyStamps,
        serializeIncludeDecls,
        serializePreprocessedState
    } = createIncludeCacheCodec({
        normalizeFsPath,
        getDefineStateKey,
        getDefineStateSignature
    });

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

    function getActiveFilesSignature(activeFiles) {
        if (!(activeFiles instanceof Set)) return '';
        return [...activeFiles]
            .map(filePath => normalizeFsPath(filePath))
            .filter(Boolean)
            .sort()
            .join('|');
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
        const revivedDecls = serializedDecls.map(item => {
            const decl = reviveIncludeDeclCompactObject(item);
            return {
                ...decl,
                modifiers: Array.isArray(decl.modifiers) ? [...decl.modifiers] : []
            };
        });
        const decls = dedupeIncludeDecls(revivedDecls);
        const indexes = decls.length === revivedDecls.length ? options.indexes : null;
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
            ? attachIncludeDeclIndexesFromSerializedOrBuild(decls, indexes)
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

    const {
        clearPersistentIncludeDeclCache,
        prunePersistentIncludeDeclCache,
        readPersistentActiveIncludeDeclCache,
        readPersistentIncludeDeclCache,
        readPersistentIncludePreprocessedState,
        writePersistentActiveIncludeDeclCache,
        writePersistentIncludeDeclCache,
        writePersistentIncludePreprocessedState
    } = createIncludePersistentCache({
        fs,
        path,
        normalizeFsPath,
        persistentIncludeDeclCacheRoot,
        persistentIncludeDeclCacheMaxBytes,
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
    });

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
        const normalized = normalizeExtensionList(rawExtensions, [], { useFallbackWhenEmpty: false });
        return getEffectiveIncludeFileExtensions(normalized, { useDefaultCustomWhenEmpty: true });
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
        const declAccumulator = createIncludeDeclAccumulator();
        for (const entry of includeEntries) {
            const preparedState = includePreprocessedStates
                ? includePreprocessedStates.get(getIncludePreprocessedStateKey(entry.filePath, entry.defineStateKey, entry.defineDecls || []))
                : null;
            const parsedDecls = parseIncludeFile(entry.filePath, entry.defineDecls, entry.defineStateKey, preparedState) || [];
            for (const decl of parsedDecls) declAccumulator.pushDecl(decl);
        }
        const decls = declAccumulator.finish();
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
