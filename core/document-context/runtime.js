const path = require('path');

// Shared document-context runtime. This keeps the heavy snapshot/context builder
// separate from cache-key helpers and from feature-specific code such as hover or
// live validation.
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
        touchWarmedIncludeDocument
    } = deps;
    const safeDocumentContextVersionHistory = documentContextVersionHistory || new Map();
    const safeDocumentEditImpactHistory = documentEditImpactHistory || new Map();
    const safeTrackVersionedDocumentCacheVersion =
        typeof trackVersionedDocumentCacheVersion === 'function'
            ? trackVersionedDocumentCacheVersion
            : (() => {});
    const documentIdentityByObject = new WeakMap();
    let nextDocumentIdentity = 1;

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

    function buildIncrementalPreprocessedState(previousSharedContext, rawLines, editImpact) {
        if (!previousSharedContext?.preprocessedState || editImpact?.kind !== 'incremental') {
            return null;
        }
        const previousContent = String(previousSharedContext.preprocessedState.content || '');
        const previousLines = previousContent.split(/\r?\n/);
        if (!previousLines.length || previousLines.length !== rawLines.length) {
            return null;
        }

        const nextLines = previousLines.slice();
        for (const range of editImpact.ranges || []) {
            const startLine = Math.max(0, range?.startLine ?? 0);
            const endLine = Math.min(rawLines.length - 1, Math.max(startLine, range?.endLine ?? startLine));
            for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
                nextLines[lineNumber] = String(rawLines[lineNumber] || '');
            }
        }

        return {
            ...previousSharedContext.preprocessedState,
            content: nextLines.join('\n'),
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

        for (const range of editImpact.ranges || []) {
            const startLine = Math.max(0, range?.startLine ?? 0);
            const endLine = Math.min(nextStrippedLines.length - 1, Math.max(startLine, range?.endLine ?? startLine));
            for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
                if (String(previousStrippedLines[lineNumber] || '') !== String(nextStrippedLines[lineNumber] || '')) {
                    return false;
                }
                if ((previousLineCtrlChars[lineNumber] || null) !== (nextLineCtrlChars[lineNumber] || null)) {
                    return false;
                }
            }
        }
        return true;
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
            const fn = path.basename(fp);
            const text = document.getText();
            const searchPaths = getSearchPaths(fp);
            const textSnapshot = getFileSnapshot(fp, text);
            const ctrlCharState = textSnapshot.ctrlCharState;
            const editImpact = getDocumentEditImpactForVersion(fp, document.version);
            const previousSharedContext = editImpact?.kind === 'incremental'
                ? getPreviousSharedContext(fp, document.version, includeDeclsEnabled, documentIdentity)
                : null;
            sharedContext = withCtrlCharForContent(text, () => {
                const reusedPreprocessedState = buildIncrementalPreprocessedState(
                    previousSharedContext,
                    textSnapshot.rawLines,
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
                    semanticSession: createSemanticSessionState()
                };
            }, fp, ctrlCharState.finalCtrlChar);
            sharedDocumentContextCache.set(sharedCacheKey, sharedContext);
            safeTrackVersionedDocumentCacheVersion(fp, document.version);
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

    function parseContextDeclsFromSharedContext(sharedContext, cursorLine, options = {}) {
        const includeRootLineByPath = new Map();
        let currentRootIncludeLine = -1;
        for (const entry of sharedContext.includeEntries || []) {
            if (!entry?.filePath) continue;
            if (Number(entry.depth || 0) === 0 || currentRootIncludeLine < 0) {
                currentRootIncludeLine = Number.isInteger(entry.lineNumber) ? entry.lineNumber : -1;
            }
            const includeLine = currentRootIncludeLine;
            const key = normalizeFsPath(entry.filePath);
            if (!key || includeLine < 0) continue;
            const previousLine = includeRootLineByPath.get(key);
            if (previousLine == null || includeLine < previousLine) {
                includeRootLineByPath.set(key, includeLine);
            }
        }
        const includeDeclsCacheKey = sharedContext.incDecls?.length
            ? `includes:${sharedContext.incDecls.length}:` +
                (sharedContext.includeEntries || [])
                    .map(entry => normalizeFsPath(entry?.filePath || ''))
                    .filter(Boolean)
                    .join('|')
            : '';
        const getOuterDeclsForLine = lineNumber => {
            if (!sharedContext.incDecls?.length || !includeRootLineByPath.size) {
                return sharedContext.incDecls;
            }
            const maxLine = Number.isInteger(lineNumber) ? lineNumber : Number.MAX_SAFE_INTEGER;
            return sharedContext.incDecls.filter(decl => {
                const includeLine = includeRootLineByPath.get(normalizeFsPath(decl?.filePath || ''));
                return includeLine == null || includeLine <= maxLine;
            });
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
                getOuterDeclsForLine,
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
        const documentFilePath = normalizeFsPath(document.fileName);

        let ctx = null;
        try {
            ctx = getPawnDocumentContext(document, undefined);
        } catch (err) {
            console.error('warmIncludedDocumentModels:', err);
            return;
        }
        if (!ctx?.includeEntries?.length) return;

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

        for (const filePath of candidates) {
            if (touchWarmedIncludeDocument(filePath)) continue;
            vscode.workspace.openTextDocument(vscode.Uri.file(filePath)).then(
                () => {},
                () => {}
            );
        }
    }

    function scheduleWarmDocumentContext(document, delayMs = 120) {
        if (!isPawnDocument(document)) return;
        const normalized = normalizeFsPath(document.fileName);
        if (!normalized) return;

        clearScheduledWarmup(document.fileName);
        const timer = setTimeout(() => {
            documentWarmupTimers.delete(normalized);
            warmDocumentContext(document);
            warmIncludedDocumentModels(document);
        }, delayMs);
        documentWarmupTimers.set(normalized, timer);
    }

    return {
        getPawnDocumentContext,
        createPawnDocumentContextSession,
        clearScheduledWarmup,
        warmDocumentContext,
        warmIncludedDocumentModels,
        scheduleWarmDocumentContext
    };
}

module.exports = { createDocumentContextCore };
