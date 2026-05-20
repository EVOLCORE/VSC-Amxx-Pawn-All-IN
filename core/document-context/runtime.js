const path = require('path');

// Shared document-context runtime. This keeps the heavy snapshot/context builder
// separate from cache-key helpers and from feature-specific code such as hover or
// live validation.
const { splitPawnLines } = require('../syntax/lines');
const {
    forEachEditImpactLine,
    patchChangedLineArray
} = require('./incremental-lines');
const {
    isPreferredIncludeCandidate,
    normalizeIncludePriority
} = require('../include-priority');

const { unrefTimer } = require('../utils/timers');

function createDocumentContextCore(deps) {
    const {
        vscode,
        isPawnDocument,
        normalizeFsPath,
        getIncludeDocumentWarmupFileLimit,
        getSearchPaths,
        getCtrlCharStateForContent,
        getFileSnapshot,
        withCtrlCharForContent,
        preprocessPawnContent,
        getActiveDecls,
        createCtrlCharResolver,
        parseFileDecls,
        filterEnumEvalOuterDecls,
        buildDocumentDeclLookup,
        getDocumentContextCacheKey,
        getSharedDocumentContextCacheKey,
        sharedDocumentContextCache,
        documentContextVersionHistory,
        documentEditImpactHistory,
        documentContextCache,
        trackVersionedDocumentCacheVersion,
        touchDocumentContextCacheFile,
        pruneDocumentContextCache,
        buildDependencyStampMap,
        areDependencyStampsFresh,
        documentWarmupTimers,
        touchWarmedIncludeDocument,
        debugOutputChannel = null
    } = deps;
    const safeDocumentContextVersionHistory = documentContextVersionHistory || new Map();
    const safeDocumentEditImpactHistory = documentEditImpactHistory || new Map();
    const safeTrackVersionedDocumentCacheVersion =
        typeof trackVersionedDocumentCacheVersion === 'function'
            ? trackVersionedDocumentCacheVersion
            : (() => {});
    const documentIdentityByObject = new WeakMap();
    let nextDocumentIdentity = 1;
    const includeDocumentWarmupStateByFile = new Map();
    const INCLUDE_DOCUMENT_WARMUP_STATE_LIMIT = 64;
    const logContext = message => {
        try {
            debugOutputChannel?.appendLine?.(`[context] ${message}`);
        } catch {
            // Debug logging must never affect context building.
        }
    };

    function getDocumentIdentity(document) {
        if (!document || (typeof document !== 'object' && typeof document !== 'function')) return '';
        let identity = documentIdentityByObject.get(document);
        if (!identity) {
            identity = `doc${nextDocumentIdentity++}`;
            documentIdentityByObject.set(document, identity);
        }
        return identity;
    }

    function getDocumentEditImpactForVersion(filePath, version) {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return null;
        const entry = safeDocumentEditImpactHistory.get(normalized) || null;
        if (!entry || entry.version !== version) return null;
        return entry.editImpact || null;
    }

    function getPreviousSharedContext(filePath, currentVersion, includeDeclsEnabled, documentIdentity = '') {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return null;
        const versions = safeDocumentContextVersionHistory.get(normalized) || [];
        for (let index = versions.length - 1; index >= 0; index--) {
            const version = versions[index];
            if (!Number.isInteger(version) || version === currentVersion) continue;
            const cacheKey = getSharedDocumentContextCacheKey(filePath, version, includeDeclsEnabled, documentIdentity);
            const sharedContext = sharedDocumentContextCache.get(cacheKey);
            if (!sharedContext) continue;
            if (!areDependencyStampsFresh(sharedContext.dependencyStamps)) {
                sharedDocumentContextCache.delete(cacheKey);
                continue;
            }
            return sharedContext;
        }
        return null;
    }

    function buildIncrementalPreprocessedState(previousSharedContext, textSnapshot, editImpact) {
        if (!previousSharedContext?.preprocessedState || editImpact?.kind !== 'incremental') {
            return null;
        }
        const rawLines = textSnapshot?.rawLines || [];
        const previousContent = String(previousSharedContext.preprocessedState.content || '');
        const previousLines = splitPawnLines(previousContent);
        if (!previousLines.length || previousLines.length !== rawLines.length) {
            return null;
        }

        const nextLines = previousLines.slice();
        const previousStrippedLines = Array.isArray(previousSharedContext.preprocessedState.strippedLines)
            ? previousSharedContext.preprocessedState.strippedLines
            : previousLines;
        const currentStrippedLines = Array.isArray(textSnapshot?.strippedLines)
            ? textSnapshot.strippedLines
            : rawLines;
        const nextStrippedLines = previousStrippedLines.length === rawLines.length
            ? previousStrippedLines.slice()
            : nextLines.slice();
        const previousLineCtrlChars = Array.isArray(previousSharedContext.preprocessedState.lineCtrlChars)
            ? previousSharedContext.preprocessedState.lineCtrlChars
            : [];
        const currentLineCtrlChars = Array.isArray(textSnapshot?.lineCtrlChars)
            ? textSnapshot.lineCtrlChars
            : [];
        const nextLineCtrlChars = previousLineCtrlChars.length === rawLines.length
            ? previousLineCtrlChars.slice()
            : new Array(rawLines.length).fill('');
        patchChangedLineArray(nextLines, rawLines, editImpact, {
            lineCount: rawLines.length,
            readLine: lineNumber => String(rawLines[lineNumber] || '')
        });
        patchChangedLineArray(nextStrippedLines, currentStrippedLines, editImpact, {
            lineCount: rawLines.length,
            readLine: lineNumber => String(currentStrippedLines[lineNumber] ?? rawLines[lineNumber] ?? '')
        });
        patchChangedLineArray(nextLineCtrlChars, currentLineCtrlChars, editImpact, {
            lineCount: rawLines.length,
            readLine: lineNumber => currentLineCtrlChars[lineNumber] || ''
        });

        return {
            ...previousSharedContext.preprocessedState,
            content: nextLines.join('\n'),
            rawLines: nextLines,
            strippedLines: nextStrippedLines,
            lineCtrlChars: nextLineCtrlChars,
            finalCtrlChar: textSnapshot?.finalCtrlChar || previousSharedContext.preprocessedState.finalCtrlChar || '^',
            includePreprocessedStates: null
        };
    }

    function isSemanticallyEquivalentIncrementalEdit(previousSharedContext, textSnapshot, editImpact) {
        if (!previousSharedContext?.textSnapshot || editImpact?.kind !== 'incremental') {
            return false;
        }
        const previousSnapshot = previousSharedContext.textSnapshot;
        const nextStrippedLines = textSnapshot?.strippedLines;
        const previousStrippedLines = previousSnapshot.strippedLines;
        const nextLineCtrlChars = textSnapshot?.lineCtrlChars || [];
        const previousLineCtrlChars = previousSnapshot.lineCtrlChars || [];
        if (
            !Array.isArray(nextStrippedLines) ||
            !Array.isArray(previousStrippedLines) ||
            nextStrippedLines.length !== previousStrippedLines.length
        ) {
            return false;
        }

        let equivalent = true;
        forEachEditImpactLine(editImpact, nextStrippedLines.length, lineNumber => {
            if (!equivalent) return;
            if (String(previousStrippedLines[lineNumber] || '') !== String(nextStrippedLines[lineNumber] || '')) {
                equivalent = false;
                return;
            }
            if ((previousLineCtrlChars[lineNumber] || null) !== (nextLineCtrlChars[lineNumber] || null)) {
                equivalent = false;
            }
        });
        return equivalent;
    }

    function createSemanticSessionState() {
        return {
            analysisCacheByParsedDecls: new WeakMap(),
            wordMatchesByParsedDecls: new WeakMap(),
            rawIndexedExpressionsByLine: [],
            strippedIndexedExpressionsByLine: [],
            inlineCallsByLine: [],
            liveValidationCandidateDiagnosticsBySignature: new Map(),
            liveValidationLineDiagnosticsBySignature: new Map(),
            liveValidationHeaderDiagnosticsBySignature: new Map(),
            lineStartOffsets: null,
            callContextIndex: null
        };
    }

    function getOrCreateSharedContext(document, includeDeclsEnabled = true) {
        if (!isPawnDocument(document)) return null;

        const fp = document.fileName;
        const documentIdentity = getDocumentIdentity(document);
        const sharedCacheKey = getSharedDocumentContextCacheKey(fp, document.version, includeDeclsEnabled, documentIdentity);
        let sharedContext = sharedDocumentContextCache.get(sharedCacheKey);
        if (sharedContext && !areDependencyStampsFresh(sharedContext.dependencyStamps)) {
            sharedDocumentContextCache.delete(sharedCacheKey);
            sharedContext = null;
        }
        const touchAndPruneContextFile = () => {
            touchDocumentContextCacheFile(fp);
            pruneDocumentContextCache(fp);
        };
        if (!sharedContext) {
            const sharedStartedAt = Date.now();
            const fn = path.basename(fp);
            const text = document.getText();
            const searchPaths = getSearchPaths(fp);
            logContext(
                `shared-start file=${fp} version=${document.version} includeDecls=${includeDeclsEnabled ? 1 : 0} ` +
                `chars=${text.length}`
            );
            const textSnapshot = getFileSnapshot(fp, text);
            const ctrlCharState = textSnapshot.ctrlCharState;
            const editImpact = getDocumentEditImpactForVersion(fp, document.version);
            const previousSharedContext = editImpact?.kind === 'incremental'
                ? getPreviousSharedContext(fp, document.version, includeDeclsEnabled, documentIdentity)
                : null;
            sharedContext = withCtrlCharForContent(text, () => {
                const reusedPreprocessedState = buildIncrementalPreprocessedState(
                    previousSharedContext,
                    textSnapshot,
                    editImpact
                );
                const semanticEquivalentIncrementalEdit = reusedPreprocessedState && previousSharedContext
                    ? isSemanticallyEquivalentIncrementalEdit(previousSharedContext, textSnapshot, editImpact)
                    : false;
                const preprocessedState = reusedPreprocessedState || preprocessPawnContent(text, {
                    fromFilePath: fp,
                    searchPaths,
                    rawLines: textSnapshot.rawLines,
                    strippedLines: textSnapshot.strippedLines,
                    lineCtrlChars: ctrlCharState.lineCtrlChars || [],
                    finalCtrlChar: ctrlCharState.finalCtrlChar,
                    directiveCandidateLines: ctrlCharState.directiveCandidateLines || null,
                    captureIncludePreprocessedStates: includeDeclsEnabled,
                    returnState: true
                });
                if (semanticEquivalentIncrementalEdit && editImpact?.bodyOnly === true) {
                    preprocessedState.semanticEquivalentBodyEdit = true;
                }
                const incDecls = includeDeclsEnabled
                    ? (reusedPreprocessedState && previousSharedContext
                        ? previousSharedContext.incDecls
                        : getActiveDecls(text, searchPaths, fp, preprocessedState))
                    : [];
                const dependencyStamps = reusedPreprocessedState && previousSharedContext
                    ? previousSharedContext.dependencyStamps
                    : buildDependencyStampMap(
                        (preprocessedState.includeEntries || []).map(entry => entry.filePath)
                    );
                return {
                    document,
                    fp,
                    fn,
                    text,
                    textSnapshot,
                    finalCtrlChar: textSnapshot.finalCtrlChar,
                    preprocessedState,
                    includeEntries: preprocessedState.includeEntries || [],
                    resolver: createCtrlCharResolver(text, fp, textSnapshot.lineCtrlChars),
                    incDecls,
                    dependencyStamps,
                    contextByParsedDecls: new WeakMap(),
                    sequentialContextState: null,
                    includeMetadata: null,
                    semanticSession: createSemanticSessionState()
                };
            }, fp, ctrlCharState.finalCtrlChar);
            sharedDocumentContextCache.set(sharedCacheKey, sharedContext);
            safeTrackVersionedDocumentCacheVersion(fp, document.version);
            logContext(
                `shared-done file=${fp} version=${document.version} includeDecls=${includeDeclsEnabled ? 1 : 0} ` +
                `lines=${textSnapshot.rawLines.length} includes=${sharedContext.includeEntries.length} ` +
                `incDecls=${sharedContext.incDecls.length} ms=${Date.now() - sharedStartedAt}`
            );
        }
        touchAndPruneContextFile();
        return sharedContext;
    }

    function buildContextFromParsedDecls(sharedContext, parsedDecls) {
        const cachedContext = sharedContext.contextByParsedDecls.get(parsedDecls);
        if (cachedContext) {
            return cachedContext;
        }

        const builtContext = {
            document: sharedContext.document,
            fp: sharedContext.fp,
            fn: sharedContext.fn,
            text: sharedContext.text,
            resolver: sharedContext.resolver,
            rawLines: sharedContext.textSnapshot.rawLines,
            strippedLines: sharedContext.textSnapshot.strippedLines,
            lineCtrlChars: sharedContext.textSnapshot.lineCtrlChars,
            lineIndex: null,
            lineStartOffsets: null,
            bodyDeclarationContextChangeFlags: null,
            preprocessedState: sharedContext.preprocessedState,
            includeEntries: sharedContext.includeEntries,
            dependencyStamps: sharedContext.dependencyStamps,
            parsedDecls,
            incDecls: sharedContext.incDecls,
            semanticSession: sharedContext.semanticSession,
            getIncludeSourceMetaForPath: filePath =>
                getSharedIncludeMetadata(sharedContext).includeSourceMetaByPath.get(normalizeFsPath(filePath)) || null,
            lookup: null,
            allDecls: null
        };
        let lineIndex = null;
        let lineStartOffsets = null;
        let bodyDeclarationContextChangeFlags = null;
        let lookup = null;
        let allDecls = null;
        Object.defineProperties(builtContext, {
            lineIndex: {
                enumerable: true,
                configurable: true,
                get() {
                    if (!lineIndex) {
                        lineIndex = sharedContext.textSnapshot.lineIndex;
                    }
                    return lineIndex;
                }
            },
            lineStartOffsets: {
                enumerable: true,
                configurable: true,
                get() {
                    if (!lineStartOffsets) {
                        lineStartOffsets = sharedContext.textSnapshot.lineStartOffsets;
                    }
                    return lineStartOffsets;
                }
            },
            bodyDeclarationContextChangeFlags: {
                enumerable: true,
                configurable: true,
                get() {
                    if (!bodyDeclarationContextChangeFlags) {
                        bodyDeclarationContextChangeFlags = sharedContext.textSnapshot.bodyDeclarationContextChangeFlags;
                    }
                    return bodyDeclarationContextChangeFlags;
                }
            },
            lookup: {
                enumerable: true,
                configurable: true,
                get() {
                    if (!lookup) {
                        lookup = buildDocumentDeclLookup(parsedDecls, sharedContext.incDecls);
                    }
                    return lookup;
                }
            },
            allDecls: {
                enumerable: true,
                configurable: true,
                get() {
                    if (!allDecls) {
                        allDecls = [
                            ...parsedDecls.funcArgs,
                            ...parsedDecls.locals,
                            ...parsedDecls.globals,
                            ...sharedContext.incDecls
                        ];
                    }
                    return allDecls;
                }
            }
        });
        sharedContext.contextByParsedDecls.set(parsedDecls, builtContext);
        return builtContext;
    }

    function buildSharedIncludeMetadata(sharedContext) {
        const includeRootLineByPath = new Map();
        const includeSourceMetaByPath = new Map();
        let currentRootIncludeLine = -1;
        let maxRootIncludeLine = -1;
        for (const entry of sharedContext.includeEntries || []) {
            if (!entry?.filePath) continue;
            if (Number(entry.depth || 0) === 0 || currentRootIncludeLine < 0) {
                currentRootIncludeLine = Number.isInteger(entry.lineNumber) ? entry.lineNumber : -1;
            }
            const includeLine = currentRootIncludeLine;
            const key = normalizeFsPath(entry.filePath);
            if (!key || includeLine < 0) continue;
            const sourcePriority = normalizeIncludePriority(entry.sourcePriority);
            const previousSourceMeta = includeSourceMetaByPath.get(key);
            if (isPreferredIncludeCandidate({ sourcePriority }, previousSourceMeta)) {
                includeSourceMetaByPath.set(key, {
                    sourcePath: entry.sourcePath || '',
                    sourcePriority,
                    resolutionKind: entry.resolutionKind || ''
                });
            }
            const previousLine = includeRootLineByPath.get(key);
            if (previousLine == null || includeLine < previousLine) {
                includeRootLineByPath.set(key, includeLine);
            }
            if (includeLine > maxRootIncludeLine) {
                maxRootIncludeLine = includeLine;
            }
        }
        const includeDeclsCacheKey = sharedContext.incDecls?.length
            ? `includes:${sharedContext.incDecls.length}:` +
                (sharedContext.includeEntries || [])
                    .map(entry => normalizeFsPath(entry?.filePath || ''))
                    .filter(Boolean)
                    .join('|')
            : '';
        const enumEvalOuterDecls = typeof filterEnumEvalOuterDecls === 'function'
            ? filterEnumEvalOuterDecls(sharedContext.incDecls)
            : sharedContext.incDecls;
        return {
            includeRootLineByPath,
            includeSourceMetaByPath,
            maxRootIncludeLine,
            includeDeclsCacheKey,
            enumEvalOuterDecls,
            includeLineByDeclFilePath: new Map(),
            outerDeclsByLine: new Map(),
            enumEvalOuterDeclsByLine: new Map()
        };
    }

    function getSharedIncludeMetadata(sharedContext) {
        if (!sharedContext.includeMetadata) {
            sharedContext.includeMetadata = buildSharedIncludeMetadata(sharedContext);
        }
        return sharedContext.includeMetadata;
    }

    function parseContextDeclsFromSharedContext(sharedContext, cursorLine, options = {}) {
        const includeMetadata = getSharedIncludeMetadata(sharedContext);
        const {
            includeRootLineByPath,
            maxRootIncludeLine,
            includeDeclsCacheKey,
            enumEvalOuterDecls,
            includeLineByDeclFilePath,
            outerDeclsByLine,
            enumEvalOuterDeclsByLine
        } = includeMetadata;
        const getIncludeLineForDecl = decl => {
            const filePath = String(decl?.filePath || '');
            if (includeLineByDeclFilePath.has(filePath)) {
                return includeLineByDeclFilePath.get(filePath);
            }
            const includeLine = includeRootLineByPath.get(normalizeFsPath(filePath));
            const normalizedIncludeLine = includeLine == null ? null : includeLine;
            includeLineByDeclFilePath.set(filePath, normalizedIncludeLine);
            return normalizedIncludeLine;
        };
        const getOuterDeclsForLine = lineNumber => {
            if (!sharedContext.incDecls?.length || !includeRootLineByPath.size) {
                return sharedContext.incDecls;
            }
            const maxLine = Number.isInteger(lineNumber) ? lineNumber : Number.MAX_SAFE_INTEGER;
            if (maxRootIncludeLine >= 0 && maxLine >= maxRootIncludeLine) {
                return sharedContext.incDecls;
            }
            const cached = outerDeclsByLine.get(maxLine);
            if (cached) return cached;
            const filtered = [];
            for (const decl of sharedContext.incDecls) {
                const includeLine = getIncludeLineForDecl(decl);
                if (includeLine == null || includeLine <= maxLine) {
                    filtered.push(decl);
                }
            }
            outerDeclsByLine.set(maxLine, filtered);
            return filtered;
        };
        const getEnumEvalOuterDeclsForLine = lineNumber => {
            if (!Array.isArray(enumEvalOuterDecls) || !enumEvalOuterDecls.length || !includeRootLineByPath.size) {
                return enumEvalOuterDecls;
            }
            const maxLine = Number.isInteger(lineNumber) ? lineNumber : Number.MAX_SAFE_INTEGER;
            if (maxRootIncludeLine >= 0 && maxLine >= maxRootIncludeLine) {
                return enumEvalOuterDecls;
            }
            const cached = enumEvalOuterDeclsByLine.get(maxLine);
            if (cached) return cached;
            const filtered = [];
            for (const decl of enumEvalOuterDecls) {
                const includeLine = getIncludeLineForDecl(decl);
                if (includeLine == null || includeLine <= maxLine) {
                    filtered.push(decl);
                }
            }
            enumEvalOuterDeclsByLine.set(maxLine, filtered);
            return filtered;
        };
        return withCtrlCharForContent(sharedContext.text, () => parseFileDecls(
            sharedContext.text,
            sharedContext.fp,
            sharedContext.fn,
            cursorLine,
            sharedContext.preprocessedState,
            {
                cursorCache: options.cursorCache !== false,
                preparseLocals: options.preparseLocals === true,
                outerDecls: sharedContext.incDecls,
                enumEvalOuterDecls,
                getOuterDeclsForLine,
                getEnumEvalOuterDeclsForLine,
                outerDeclsCacheKey: includeDeclsCacheKey
            }
        ), sharedContext.fp, sharedContext.finalCtrlChar);
    }

    function getPawnDocumentContext(document, cursorLine, options = {}) {
        if (!isPawnDocument(document)) return null;

        const fp = document.fileName;
        const includeDeclsEnabled = options.includeDecls !== false;
        const isEphemeral = options.ephemeral === true;
        const useCursorCache = options.cursorCache !== false;
        const preparseLocals = options.preparseLocals === true;
        const documentIdentity = getDocumentIdentity(document);
        const cacheKey = getDocumentContextCacheKey(
            fp,
            document.version,
            cursorLine,
            includeDeclsEnabled,
            documentIdentity,
            preparseLocals
        );
        if (!isEphemeral) {
            const cached = documentContextCache.get(cacheKey);
            if (cached && areDependencyStampsFresh(cached.dependencyStamps)) {
                touchDocumentContextCacheFile(fp);
                return cached;
            }
            if (cached) {
                documentContextCache.delete(cacheKey);
            }
        }
        const sharedContext = getOrCreateSharedContext(document, includeDeclsEnabled);

        const previousSequentialContextState = sharedContext.sequentialContextState;
        const cursorStartedAt = Date.now();
        logContext(
            `cursor-start file=${fp} version=${document.version} line=${cursorLine === undefined ? 'all' : cursorLine} ` +
            `includeDecls=${includeDeclsEnabled ? 1 : 0} preparseLocals=${preparseLocals ? 1 : 0}`
        );
        const parsedDecls = parseContextDeclsFromSharedContext(sharedContext, cursorLine, {
            cursorCache: useCursorCache,
            preparseLocals
        });
        const canReuseSequentialContext = !!(
            !isEphemeral &&
            cursorLine !== undefined &&
            previousSequentialContextState &&
            previousSequentialContextState.cursorLine < cursorLine &&
            previousSequentialContextState.parsedDecls === parsedDecls
        );
        const context = canReuseSequentialContext
            ? previousSequentialContextState.context
            : buildContextFromParsedDecls(sharedContext, parsedDecls);
        if (!isEphemeral && cursorLine !== undefined) {
            sharedContext.sequentialContextState = {
                cursorLine,
                parsedDecls: context.parsedDecls,
                context
            };
        }
        if (!isEphemeral) {
            documentContextCache.set(cacheKey, context);
            touchDocumentContextCacheFile(fp);
            pruneDocumentContextCache(fp);
        }
        logContext(
            `cursor-done file=${fp} version=${document.version} line=${cursorLine === undefined ? 'all' : cursorLine} ` +
            `globals=${context.parsedDecls.globals.length} locals=${context.parsedDecls.locals.length} ` +
            `funcs=${context.parsedDecls.functions.length} args=${context.parsedDecls.funcArgs.length} ` +
            `incDecls=${context.incDecls.length} ms=${Date.now() - cursorStartedAt}`
        );
        return context;
    }

    function createPawnDocumentContextSession(document, options = {}) {
        if (!isPawnDocument(document)) return null;
        const includeDeclsEnabled = options.includeDecls !== false;
        const sharedContext = getOrCreateSharedContext(document, includeDeclsEnabled);
        if (!sharedContext) return null;

        const defaultCursorCache = options.cursorCache !== false;
        const defaultPreparseLocals = options.preparseLocals === true;
        return {
            semanticSession: sharedContext.semanticSession,
            getContext(cursorLine, lineOptions = {}) {
                const parsedDecls = parseContextDeclsFromSharedContext(sharedContext, cursorLine, {
                    cursorCache: lineOptions.cursorCache !== false && defaultCursorCache,
                    preparseLocals: lineOptions.preparseLocals === true || defaultPreparseLocals
                });
                return buildContextFromParsedDecls(sharedContext, parsedDecls);
            }
        };
    }

    function clearScheduledWarmup(filePath = '') {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return;
        const timer = documentWarmupTimers.get(normalized);
        if (timer) {
            clearTimeout(timer);
            documentWarmupTimers.delete(normalized);
        }
    }

    function rememberIncludeDocumentWarmup(filePath = '', key = '') {
        const normalized = normalizeFsPath(filePath);
        if (!normalized || !key) return;
        includeDocumentWarmupStateByFile.delete(normalized);
        includeDocumentWarmupStateByFile.set(normalized, key);
        while (includeDocumentWarmupStateByFile.size > INCLUDE_DOCUMENT_WARMUP_STATE_LIMIT) {
            const oldestKey = includeDocumentWarmupStateByFile.keys().next().value;
            includeDocumentWarmupStateByFile.delete(oldestKey);
        }
    }

    function hasRecentIncludeDocumentWarmup(filePath = '', key = '') {
        const normalized = normalizeFsPath(filePath);
        if (!normalized || !key) return false;
        return includeDocumentWarmupStateByFile.get(normalized) === key;
    }

    function clearAllScheduledWarmups() {
        for (const filePath of [...documentWarmupTimers.keys()]) {
            clearScheduledWarmup(filePath);
        }
    }

    function warmDocumentContext(document) {
        if (!isPawnDocument(document)) return;

        try {
            getPawnDocumentContext(document, undefined);
        } catch (err) {
            console.error('warmDocumentContext:', err);
        }
    }

    function warmIncludedDocumentModels(document) {
        if (!isPawnDocument(document)) return;
        const maxFiles = getIncludeDocumentWarmupFileLimit();
        if (maxFiles === 0) return;
        const searchPathSignature = (getSearchPaths(document.fileName) || [])
            .map(item => normalizeFsPath(item))
            .filter(Boolean)
            .join('|');
        const warmupKey = `v${document.version ?? 'unknown'}:limit:${maxFiles}:paths:${searchPathSignature}`;
        if (hasRecentIncludeDocumentWarmup(document.fileName, warmupKey)) {
            logContext(`warm-includes-skip file=${document.fileName || ''} cause=already-warmed limit=${maxFiles}`);
            return;
        }
        const documentFilePath = normalizeFsPath(document.fileName);
        const startedAt = Date.now();
        logContext(`warm-includes-start file=${document.fileName || ''} limit=${maxFiles}`);

        let ctx = null;
        try {
            ctx = getPawnDocumentContext(document, undefined);
        } catch (err) {
            console.error('warmIncludedDocumentModels:', err);
            return;
        }
        if (!ctx?.includeEntries?.length) {
            rememberIncludeDocumentWarmup(document.fileName, warmupKey);
            return;
        }

        const directCandidates = [];
        const nestedCandidates = [];
        const seen = new Set();
        for (const entry of ctx.includeEntries) {
            const filePath = entry?.filePath || '';
            const normalized = normalizeFsPath(filePath);
            if (!normalized || seen.has(normalized) || normalized === documentFilePath) continue;
            seen.add(normalized);
            const targetList = Number(entry?.depth || 0) === 0 ? directCandidates : nestedCandidates;
            targetList.push(filePath);
            if (maxFiles > 0 && directCandidates.length + nestedCandidates.length >= maxFiles) break;
        }

        const candidates = directCandidates.concat(nestedCandidates);

        let opened = 0;
        let skipped = 0;
        for (const filePath of candidates) {
            if (touchWarmedIncludeDocument(filePath)) {
                skipped++;
                continue;
            }
            opened++;
            vscode.workspace.openTextDocument(vscode.Uri.file(filePath)).then(
                () => {},
                () => {}
            );
        }
        logContext(
            `warm-includes-done file=${document.fileName || ''} candidates=${candidates.length} ` +
            `direct=${directCandidates.length} nested=${nestedCandidates.length} opened=${opened} skipped=${skipped} ` +
            `ms=${Date.now() - startedAt}`
        );
        rememberIncludeDocumentWarmup(document.fileName, warmupKey);
    }

    function scheduleWarmDocumentContext(document, delayMs = 120) {
        if (!isPawnDocument(document)) return;
        const normalized = normalizeFsPath(document.fileName);
        if (!normalized) return;

        clearScheduledWarmup(document.fileName);
        const timer = unrefTimer(setTimeout(() => {
            documentWarmupTimers.delete(normalized);
            warmDocumentContext(document);
            warmIncludedDocumentModels(document);
        }, delayMs));
        documentWarmupTimers.set(normalized, timer);
    }

    return {
        getPawnDocumentContext,
        createPawnDocumentContextSession,
        clearScheduledWarmup,
        clearAllScheduledWarmups,
        warmDocumentContext,
        warmIncludedDocumentModels,
        scheduleWarmDocumentContext
    };
}

module.exports = { createDocumentContextCore };
