const { computeFunctionRangeMaps: defaultComputeFunctionRangeMaps } = require('../../core/declarations/scope');
const { createLiveDiagnosticsCache } = require('./diagnostics-cache');
const { EDITED_GLOBAL_REPLACEMENT_DIAGNOSTIC_CODES } = require('./diagnostic-codes');
const {
    SEMANTIC_EQUIVALENT_NARROW_LINE_THRESHOLD,
    expandChangedRangesToLines,
    shouldEscalateEditedValidation,
    resolveEditedValidationPlan,
    canUseLocalBodyEditedValidation
} = require('../../core/document-context/edit-impact');
const { createFastFunctionRangeCore } = require('../../core/syntax/function-ranges');
const { toSortedUniqueLineNumbers } = require('../../core/syntax/line-number-lists');

const { unrefTimer } = require('../../core/utils/timers');

function createLiveValidationScheduler(deps) {
    const {
        vscode,
        t,
        liveValidationTimers,
        liveValidationFullResultCache,
        normalizeFsPath,
        isPawnDocument,
        getLiveValidationMode,
        shouldRunLiveValidationScanOnOpen,
        getLiveValidationFullCacheKey,
        getPawnDocumentContext,
        collectLiveValidationDiagnostics,
        buildDependencyStampMap = () => new Map(),
        getDependencyFreshnessVersion = () => 0,
        areDependencyStampsFresh = () => false,
        warmDocumentContext,
        warmIncludedDocumentModels,
        promptRecommendedAmxxTheme,
        settingsService,
        readPersistentLiveDiagnosticsCache = null,
        writePersistentLiveDiagnosticsCache = null,
        computeFunctionRangeMaps = defaultComputeFunctionRangeMaps,
        getFileSnapshot = null,
        getCtrlCharStateForContent = null,
        normalizeLiveValidationIssueMode,
        getDocumentFingerprint: computeDocumentFingerprint,
        liveValidationOutputChannel = null
    } = deps;
    const functionValidationRangeByParsedDecls = new WeakMap();
    const fastFunctionRanges = createFastFunctionRangeCore({
        getFileSnapshot,
        getCtrlCharStateForContent
    });
    const diagnosticsCache = createLiveDiagnosticsCache({
        vscode,
        liveValidationFullResultCache,
        normalizeFsPath,
        isPawnDocument,
        getLiveValidationFullCacheKey,
        getPawnDocumentContext,
        buildDependencyStampMap,
        getDependencyFreshnessVersion,
        areDependencyStampsFresh,
        settingsService,
        readPersistentLiveDiagnosticsCache,
        normalizeLiveValidationIssueMode,
        getDocumentFingerprint: computeDocumentFingerprint,
        liveValidationOutputChannel
    });
    const {
        getCachedDocumentFingerprint,
        isDocumentSnapshotCurrent,
        shouldAllowPublishedDiagnosticsReuse,
        getCachedFullResultEntry,
        buildFullResultCacheEntry,
        setFullResultCacheEntry,
        getValidationCacheSettingsSignature,
        getCachedEditedResultEntry,
        setEditedResultCacheEntry,
        deletePublishedDiagnostics,
        setLiveValidationDiagnostics,
        updateLiveValidationDiagnostics
    } = diagnosticsCache;
    const logScheduler = message => {
        try {
            liveValidationOutputChannel?.appendLine?.(`[scheduler] ${message}`);
        } catch {
            // Scheduler logging must never affect diagnostics.
        }
    };
    const formatScanStats = stats => {
        if (!stats || typeof stats !== 'object') return '';
        const parts = [];
        for (const key of [
            'lineContexts',
            'analysisCaches',
            'indexedLines',
            'callLines',
            'usageLines',
            'functionRanges',
            'includeDeclarations'
        ]) {
            const value = stats[key];
            if (Number.isFinite(value)) parts.push(`${key}=${value}`);
        }
        return parts.length ? ` ${parts.join(' ')}` : '';
    };
    const getDiagnosticCount = diagnostics => Array.isArray(diagnostics) ? diagnostics.length : 0;

    function isLiveValidationDocument(document) {
        if (!isPawnDocument(document)) return false;
        const scheme = String(document?.uri?.scheme || '').toLowerCase();
        if (scheme && scheme !== 'file' && scheme !== 'untitled') return false;
        const fileName = String(document?.fileName || '');
        return !/\.git$/i.test(fileName);
    }

    function clearScheduledLiveValidation(filePath = '') {
        const normalized = normalizeFsPath(filePath);
        if (!normalized) return;
        const entry = liveValidationTimers.get(normalized);
        if (!entry) return;
        clearTimeout(entry.timer);
        liveValidationTimers.delete(normalized);
    }

    function findEnclosingFunctionRange(rootCtx, lineNumber, maxLine) {
        const parsedDecls = rootCtx?.parsedDecls || null;
        if (!parsedDecls) return null;
        let rangeByLine = functionValidationRangeByParsedDecls.get(parsedDecls);
        if (!rangeByLine) {
            const functions = parsedDecls.functions || [];
            const depths = parsedDecls.depths || [];
            rangeByLine = computeFunctionRangeMaps(functions, depths, maxLine + 1, {
                includeHeader: true
            }).byLine;
            functionValidationRangeByParsedDecls.set(parsedDecls, rangeByLine);
        }
        return rangeByLine[lineNumber] || null;
    }

    function addRootFunctionRangeLines(document, lines, sourceLines, rootCtx) {
        if (!rootCtx) return;
        for (const line of sourceLines) {
            const functionRange = findEnclosingFunctionRange(rootCtx, line, document.lineCount - 1);
            if (!functionRange) continue;
            for (let functionLine = functionRange.startLine; functionLine <= functionRange.endLine; functionLine++) {
                lines.add(functionLine);
            }
        }
    }

    function expandLinesToValidationLines(document, baseLines = [], options = {}) {
        const baseLineNumbers = toSortedUniqueLineNumbers(document.lineCount, baseLines);
        const lines = new Set(baseLineNumbers);
        if (!lines.size) return [];
        const semanticEquivalentEdit = options.editImpact?.semanticEquivalent === true;
        const bodyOnlyIncrementalEdit = !!(
            options.editImpact?.kind === 'incremental' &&
            options.editImpact?.bodyOnly === true &&
            !semanticEquivalentEdit
        );

        let rootCtx = null;

        if (
            bodyOnlyIncrementalEdit &&
            canUseLocalBodyEditedValidation(fastFunctionRanges.getLocalBodyContext(document), baseLineNumbers, options.editImpact)
        ) {
            return baseLineNumbers;
        }

        const fastState = fastFunctionRanges.getFunctionRangeState(document);
        if (!fastState) {
            try {
                rootCtx = getPawnDocumentContext(document, undefined) || null;
            } catch {
                rootCtx = null;
            }
            if (!rootCtx) {
                return baseLineNumbers;
            }
            if (
                bodyOnlyIncrementalEdit &&
                canUseLocalBodyEditedValidation(rootCtx, baseLineNumbers, options.editImpact)
            ) {
                return baseLineNumbers;
            }
            addRootFunctionRangeLines(document, lines, [...lines], rootCtx);
            const rootExpandedLineNumbers = toSortedUniqueLineNumbers(document.lineCount, lines);
            if (
                semanticEquivalentEdit &&
                rootExpandedLineNumbers.length > SEMANTIC_EQUIVALENT_NARROW_LINE_THRESHOLD
            ) {
                return baseLineNumbers;
            }
            return rootExpandedLineNumbers;
        }

        const fallbackLines = [];
        for (const line of [...lines]) {
            const functionRange = fastFunctionRanges.findEnclosingFunctionRange(document, line);
            if (!functionRange) {
                if ((fastState?.depthByLine?.[line] || 0) > 0) {
                    fallbackLines.push(line);
                }
                continue;
            }
            for (let functionLine = functionRange.startLine; functionLine <= functionRange.endLine; functionLine++) {
                lines.add(functionLine);
            }
        }

        if (
            (bodyOnlyIncrementalEdit && !fastFunctionRanges.getLocalBodyContext(document)) ||
            fallbackLines.length
        ) {
            try {
                rootCtx = getPawnDocumentContext(document, undefined) || null;
            } catch {
                rootCtx = null;
            }
            if (!rootCtx && !fastState) {
                return baseLineNumbers;
            }
            if (
                bodyOnlyIncrementalEdit &&
                rootCtx &&
                canUseLocalBodyEditedValidation(rootCtx, baseLineNumbers, options.editImpact)
            ) {
                return baseLineNumbers;
            }
            addRootFunctionRangeLines(document, lines, fallbackLines, rootCtx);
        }

        const expandedLineNumbers = toSortedUniqueLineNumbers(document.lineCount, lines);
        if (
            semanticEquivalentEdit &&
            expandedLineNumbers.length > SEMANTIC_EQUIVALENT_NARROW_LINE_THRESHOLD
        ) {
            return baseLineNumbers;
        }
        return expandedLineNumbers;
    }

    function scheduleLiveValidation(liveValidationCollection, document, options = {}) {
        if (!isLiveValidationDocument(document)) {
            logScheduler(
                `skip reason=${String(options.reason || 'unspecified')} cause=not-live-document ` +
                `file=${document?.fileName || ''} lang=${document?.languageId || ''}`
            );
            return;
        }
        const normalized = normalizeFsPath(document.fileName);
        if (!normalized) {
            logScheduler(`skip reason=${String(options.reason || 'unspecified')} cause=empty-path`);
            return;
        }
        const mode = getLiveValidationMode();
        const allowWhenModeOff = !!options.allowWhenModeOff;
        if (mode === 'off' && !allowWhenModeOff) {
            clearScheduledLiveValidation(document.fileName);
            liveValidationCollection.delete(document.uri);
            deletePublishedDiagnostics(normalized);
            logScheduler(`skip reason=${String(options.reason || 'unspecified')} cause=mode-off file=${document.fileName}`);
            return;
        }

        const delayMs = options.delayMs ?? 180;
        const full = !!options.full || mode === 'full' || allowWhenModeOff;
        const incomingLines = full ? [] : (options.lines || []);
        const reason = String(options.reason || 'unspecified');
        const existing = liveValidationTimers.get(normalized);
        const allowPublishedReuse = shouldAllowPublishedDiagnosticsReuse(reason);
        logScheduler(
            `schedule reason=${reason} mode=${mode} full=${full ? 1 : 0} delay=${delayMs} ` +
            `file=${document.fileName}`
        );
        if (full) {
            const cacheStartedAt = Date.now();
            const settingsSignature = getValidationCacheSettingsSignature();
            const cachedResult = getCachedFullResultEntry(document, {
                allowPublishedReuse,
                allowPersistentReuse: false,
                settingsSignature
            });
            if (cachedResult.fresh && cachedResult.diagnostics) {
                const currentFingerprint = cachedResult.cacheEntry?.documentFingerprint ||
                    getCachedDocumentFingerprint(document);
                if (!isDocumentSnapshotCurrent(document, document.version, currentFingerprint)) {
                    logScheduler(`drop-stale reason=${reason} source=full-cache file=${document.fileName}`);
                    return;
                }
                if (existing?.full && existing.version === document.version && existing.timer) {
                    clearTimeout(existing.timer);
                    liveValidationTimers.delete(normalized);
                }
                setLiveValidationDiagnostics(liveValidationCollection, document, cachedResult.diagnostics, {
                    cacheEntry: cachedResult.cacheEntry,
                    settingsSignature,
                    reason,
                    source: 'full-cache'
                });
                logScheduler(
                    `publish-cache reason=${reason} source=full-cache ` +
                    `count=${getDiagnosticCount(cachedResult.diagnostics)} ` +
                    `ms=${Date.now() - cacheStartedAt} file=${document.fileName}`
                );
                return;
            }
        }
        const mergedLines = new Set(existing?.lines || []);
        for (const line of incomingLines) mergedLines.add(line);
        if (existing?.timer) clearTimeout(existing.timer);
        const timer = unrefTimer(setTimeout(() => {
            liveValidationTimers.delete(normalized);
            const runStartedAt = Date.now();
            logScheduler(
                `run reason=${reason} mode=${mode} full=${full ? 1 : 0} ` +
                `file=${document.fileName} version=${document.version} lines=${document.lineCount || 0}`
            );
            if (!isLiveValidationDocument(document)) {
                logScheduler(
                    `run-skip reason=${reason} cause=not-live-document ` +
                    `file=${document?.fileName || ''} lang=${document?.languageId || ''}`
                );
                return;
            }
            const runVersion = document.version;
            const runFingerprint = getCachedDocumentFingerprint(document);
            const settingsSignature = getValidationCacheSettingsSignature();

            try {
                if (full) {
                    const cacheStartedAt = Date.now();
                    const cachedResult = getCachedFullResultEntry(document, {
                        allowPublishedReuse,
                        allowPersistentReuse: true,
                        settingsSignature
                    });
                    if (cachedResult.fresh && cachedResult.diagnostics) {
                        const cacheSource = cachedResult.cacheSource || 'full-cache';
                        if (!isDocumentSnapshotCurrent(document, runVersion, runFingerprint)) {
                            logScheduler(`drop-stale reason=${reason} source=${cacheSource} file=${document.fileName}`);
                            return;
                        }
                        setLiveValidationDiagnostics(liveValidationCollection, document, cachedResult.diagnostics, {
                            cacheEntry: cachedResult.cacheEntry,
                            settingsSignature,
                            reason,
                            source: cacheSource
                        });
                        logScheduler(
                            `publish-cache reason=${reason} source=${cacheSource} ` +
                            `count=${getDiagnosticCount(cachedResult.diagnostics)} ` +
                            `ms=${Date.now() - cacheStartedAt} totalMs=${Date.now() - runStartedAt} ` +
                            `file=${document.fileName}`
                        );
                        return;
                    }
                    const scanStats = {};
                    const scanStartedAt = Date.now();
                    logScheduler(
                        `scan-start reason=${reason} source=full-scan ` +
                        `version=${runVersion} lines=${document.lineCount || 0} file=${document.fileName}`
                    );
                    const diagnostics = collectLiveValidationDiagnostics(document, { scanStats });
                    if (!isDocumentSnapshotCurrent(document, runVersion, runFingerprint)) {
                        logScheduler(`drop-stale reason=${reason} source=full-scan file=${document.fileName}`);
                        return;
                    }
                    const cacheEntry = buildFullResultCacheEntry(document, diagnostics);
                    setFullResultCacheEntry(document, cachedResult.fullCacheKey, cacheEntry);
                    setLiveValidationDiagnostics(liveValidationCollection, document, diagnostics, {
                        cacheEntry,
                        reason,
                        source: 'full-scan',
                        scanStats
                    });
                    logScheduler(
                        `scan-done reason=${reason} source=full-scan ` +
                        `count=${getDiagnosticCount(diagnostics)} ` +
                        `ms=${Date.now() - scanStartedAt} totalMs=${Date.now() - runStartedAt}` +
                        `${formatScanStats(scanStats)} file=${document.fileName}`
                    );
                    if (document?.isDirty !== true && typeof writePersistentLiveDiagnosticsCache === 'function') {
                        writePersistentLiveDiagnosticsCache(document, cacheEntry, {
                            settingsSignature
                        });
                    }
                    return;
                }

                const targetLines = expandLinesToValidationLines(document, [...mergedLines], {
                    editImpact: options.editImpact || null
                });
                const focusLines = toSortedUniqueLineNumbers(document.lineCount, mergedLines);
                const cacheStartedAt = Date.now();
                const cachedEditedResult = getCachedEditedResultEntry(document, targetLines, focusLines, {
                    settingsSignature
                });
                if (cachedEditedResult.fresh) {
                    if (!isDocumentSnapshotCurrent(document, runVersion, runFingerprint)) {
                        logScheduler(`drop-stale reason=${reason} source=edited-cache file=${document.fileName}`);
                        return;
                    }
                    updateLiveValidationDiagnostics(
                        liveValidationCollection,
                        document,
                        targetLines,
                        cachedEditedResult.diagnostics,
                        {
                            settingsSignature,
                            reason,
                            source: 'edited-cache',
                            replaceDiagnosticCodes: EDITED_GLOBAL_REPLACEMENT_DIAGNOSTIC_CODES
                        }
                    );
                    logScheduler(
                        `publish-cache reason=${reason} source=edited-cache ` +
                        `lines=${targetLines.length} focus=${focusLines.length} ` +
                        `count=${getDiagnosticCount(cachedEditedResult.diagnostics)} ` +
                        `ms=${Date.now() - cacheStartedAt} totalMs=${Date.now() - runStartedAt} ` +
                        `file=${document.fileName}`
                    );
                    return;
                }
                const scanStartedAt = Date.now();
                logScheduler(
                    `scan-start reason=${reason} source=edited-scan ` +
                    `version=${runVersion} lines=${targetLines.length} focus=${focusLines.length} ` +
                    `file=${document.fileName}`
                );
                const diagnostics = collectLiveValidationDiagnostics(document, {
                    lines: targetLines,
                    focusLines
                });
                if (!isDocumentSnapshotCurrent(document, runVersion, runFingerprint)) {
                    logScheduler(`drop-stale reason=${reason} source=edited-scan file=${document.fileName}`);
                    return;
                }
                updateLiveValidationDiagnostics(liveValidationCollection, document, targetLines, diagnostics, {
                    settingsSignature,
                    reason,
                    source: 'edited-scan',
                    replaceDiagnosticCodes: EDITED_GLOBAL_REPLACEMENT_DIAGNOSTIC_CODES
                });
                logScheduler(
                    `scan-done reason=${reason} source=edited-scan ` +
                    `lines=${targetLines.length} focus=${focusLines.length} ` +
                    `count=${getDiagnosticCount(diagnostics)} ` +
                    `ms=${Date.now() - scanStartedAt} totalMs=${Date.now() - runStartedAt} ` +
                    `file=${document.fileName}`
                );
                setEditedResultCacheEntry(document, targetLines, focusLines, diagnostics, {
                    settingsSignature
                });
            } catch (error) {
                const errorText = error?.stack || error?.message || String(error);
                logScheduler(`error reason=${reason} file=${document?.fileName || ''} ${errorText}`);
                console.error('scheduleLiveValidation:', error);
            }
        }, delayMs));

        liveValidationTimers.set(normalized, {
            timer,
            lines: full ? [] : [...mergedLines],
            full,
            version: document.version,
            reason
        });
    }

    function isSameVisibleDocument(left, right) {
        if (!left || !right) return false;
        if (left === right) return true;
        const leftUri = left.uri?.toString?.() || '';
        const rightUri = right.uri?.toString?.() || '';
        if (leftUri && rightUri && leftUri === rightUri) return true;
        const leftPath = normalizeFsPath(left.fileName || '');
        const rightPath = normalizeFsPath(right.fileName || '');
        return !!leftPath && leftPath === rightPath;
    }

    function isDocumentVisibleInEditor(document) {
        if (!document) return false;
        return vscode.window.visibleTextEditors.some(editor =>
            isSameVisibleDocument(editor?.document || null, document)
        );
    }

    function handleOpenedPawnDocument(doc, liveDelayMs = 220, liveValidationCollection) {
        if (!isLiveValidationDocument(doc)) return;
        warmDocumentContext(doc);
        if (shouldRunLiveValidationScanOnOpen() && isDocumentVisibleInEditor(doc)) {
            scheduleLiveValidation(liveValidationCollection, doc, {
                full: true,
                allowWhenModeOff: true,
                delayMs: liveDelayMs,
                reason: 'openDocument'
            });
        }
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor?.document === doc) {
            promptRecommendedAmxxTheme(activeEditor);
        }
    }

    function handleActivePawnEditor(editor, liveDelayMs = 160, liveValidationCollection) {
        const doc = editor?.document || null;
        if (!isLiveValidationDocument(doc)) return;
        warmDocumentContext(doc);
        warmIncludedDocumentModels(doc);
        if (shouldRunLiveValidationScanOnOpen()) {
            scheduleLiveValidation(liveValidationCollection, doc, {
                full: true,
                allowWhenModeOff: true,
                delayMs: liveDelayMs,
                reason: 'activeEditorChanged'
            });
        }
        promptRecommendedAmxxTheme(editor);
    }

    return {
        clearScheduledLiveValidation,
        setLiveValidationDiagnostics,
        updateLiveValidationDiagnostics,
        expandChangedRangesToLines,
        shouldEscalateEditedValidation,
        resolveEditedValidationPlan,
        expandLinesToValidationLines,
        scheduleLiveValidation,
        handleOpenedPawnDocument,
        handleActivePawnEditor,
        isDocumentVisibleInEditor
    };
}

module.exports = { createLiveValidationScheduler };
