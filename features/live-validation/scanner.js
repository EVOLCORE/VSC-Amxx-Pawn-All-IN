const { createUtilityCore } = require('../../core/utils');
const {
    createDocumentScanPlanBuilder,
    buildDiagnosticLinePlan
} = require('./scan-plan');
const {
    getSemanticSignatureCache,
    getSemanticAnalysisCache
} = require('../../core/document-context/semantic-session');

const {
    normalizeLiveValidationIssueMode: defaultNormalizeLiveValidationIssueMode,
    areLiveValidationWarningsEnabled: defaultAreLiveValidationWarningsEnabled
} = createUtilityCore();

function createLiveValidationScanner(deps) {
    const {
        vscode,
        createPawnDocumentContextSession,
        createHoverTypeAnalysisCache,
        createLazyCallContextOptions,
        collectIndexedAccessExpressionsFromLine,
        collectInlineNamedCallContexts,
        findPreferredKnownCallContext,
        settingsService,
        collectIndexedAccessLiveDiagnosticsForLine,
        collectDelimiterBalanceState,
        isEnumMemberDeclarationLine,
        collectInvalidPawnCodeCharacterDiagnosticsForLine,
        collectMultilinePawnStringLiteralDiagnostics,
        collectPackedStringDefaultLineFlags,
        getLineStringStartQuoteCodes,
        collectUnknownSymbolLiveDiagnosticsForLine,
        collectStrayTokenLiveDiagnosticsForLine,
        collectExpressionOperatorLiveDiagnosticsForLine,
        collectPreprocessorAndLabelLiveDiagnostics,
        collectStructuralLiveDiagnostics,
        collectDeclarationLiveDiagnosticsForLine,
        collectCallLiveDiagnostics,
        collectHeaderLiveDiagnostics,
        collectUsageLiveDiagnostics,
        collectDynamicUsageLiveDiagnostics,
        makeLiveValidationDiagnosticKey,
        getHeaderCandidateMeta,
        normalizeLiveValidationIssueMode = defaultNormalizeLiveValidationIssueMode,
        areLiveValidationWarningsEnabled = defaultAreLiveValidationWarningsEnabled
    } = deps;
    const { getDocumentScanPlan } = createDocumentScanPlanBuilder(deps);
    const EMPTY_DIAGNOSTICS = [];
    const getLiveValidationIssueMode = () =>
        normalizeLiveValidationIssueMode(settingsService?.getLiveValidationIssueMode?.());
    const shouldKeepDiagnostic = diagnostic =>
        areLiveValidationWarningsEnabled(getLiveValidationIssueMode()) ||
        diagnostic?.severity === vscode?.DiagnosticSeverity?.Error ||
        diagnostic?.severity == null;

    function collectLiveValidationDiagnostics(document, options = {}) {
        const requestedSpecificLines = Array.isArray(options.lines) && options.lines.length;
        const isFullScanRequest = !requestedSpecificLines;
        const shouldPreparseUsageLocals =
            typeof collectUsageLiveDiagnostics === 'function' &&
            areLiveValidationWarningsEnabled(getLiveValidationIssueMode());
        const shouldPreparseRootLocals = shouldPreparseUsageLocals || isFullScanRequest;
        const contextSession = createPawnDocumentContextSession(document, {
            includeDecls: true,
            cursorCache: true,
            preparseLocals: shouldPreparseRootLocals
        });
        const getDocumentContextForScan = (cursorLine, contextOptions = {}) => {
            if (contextSession?.getContext) {
                return contextSession.getContext(cursorLine, contextOptions);
            }
            return null;
        };
        const rootCtx = getDocumentContextForScan(undefined);
        if (!rootCtx) return [];
        if (!String(rootCtx.text || '').trim()) {
            if (options.scanStats) {
                options.scanStats.targetLineCount = Array.isArray(options.lines) && options.lines.length
                    ? options.lines.length
                    : document.lineCount;
                options.scanStats.lineContextCount = 0;
                options.scanStats.analysisCacheCount = 0;
                options.scanStats.indexedLineCount = 0;
                options.scanStats.callLineCount = 0;
            }
            return [];
        }
        const scanStats = options.scanStats || null;
        const docLength = rootCtx.text.length;
        const diagnostics = [];
        const seen = new Set();
        const lineSnapshotCache = [];
        const rootLineContextFlags = new Uint8Array(document.lineCount);
        const nonRootLineContextCache = new Map();
        const lineAnalysisCache = [];
        const analysisCacheByParsedDecls =
            rootCtx.semanticSession?.analysisCacheByParsedDecls || new WeakMap();
        const semanticSessionForAnalysis = rootCtx.semanticSession || { analysisCacheByParsedDecls };
        const documentScanPlan = getDocumentScanPlan(rootCtx, document);
        const headerCandidateMeta = getHeaderCandidateMeta(rootCtx);
        const headerCandidateFunctions = headerCandidateMeta.functions;
        const callContextOptions = createLazyCallContextOptions(document, rootCtx.semanticSession || null);
        const unknownSymbolLookupState = { byLookup: new WeakMap() };
        const sequentialScanContextState = { ctx: null, cursorLine: -1, validThroughLine: -1 };
        const getCachedLineContext = lineNumber =>
            rootLineContextFlags[lineNumber]
                ? rootCtx
                : nonRootLineContextCache.get(lineNumber);
        const setCachedLineContext = (lineNumber, ctx) => {
            if (!ctx) return;
            if (ctx === rootCtx) {
                rootLineContextFlags[lineNumber] = 1;
                nonRootLineContextCache.delete(lineNumber);
                return;
            }
            rootLineContextFlags[lineNumber] = 0;
            nonRootLineContextCache.set(lineNumber, ctx);
        };
        const declarationSourceState = {
            rawLines: documentScanPlan.rawLines,
            strippedLines: rootCtx.strippedLines || documentScanPlan.rawLines,
            lineCtrlChars: documentScanPlan.lineCtrlChars,
            lineStartOffsets: rootCtx.lineStartOffsets || null
        };
        let lineStartOffsets = rootCtx.semanticSession?.lineStartOffsets || null;
        const getLineStartOffsets = () => {
            if (lineStartOffsets) return lineStartOffsets;
            lineStartOffsets = rootCtx.lineStartOffsets;
            if (!lineStartOffsets) {
                const starts = [0];
                const text = String(rootCtx.text || '');
                for (let index = 0; index < text.length; index++) {
                    if (text.charCodeAt(index) === 10) {
                        starts.push(index + 1);
                    }
                }
                lineStartOffsets = starts;
            }
            if (rootCtx.semanticSession) {
                rootCtx.semanticSession.lineStartOffsets = lineStartOffsets;
            }
            return lineStartOffsets;
        };
        const getValidationLineStartOffset = lineNumber => getLineStartOffsets()[lineNumber] ?? 0;
        const getValidationLineSnapshot = lineNumber => {
            const cachedSnapshot = lineSnapshotCache[lineNumber];
            if (cachedSnapshot !== undefined) return cachedSnapshot;
            const text = documentScanPlan.rawLines[lineNumber] ?? document.lineAt(lineNumber).text;
            const startOffset = getValidationLineStartOffset(lineNumber);
            const snapshot = { text, startOffset };
            lineSnapshotCache[lineNumber] = snapshot;
            return snapshot;
        };
        const getIndexedExpressionsForLine = (lineNumber, strippedLineText) => {
            const cachedIndexedExpressions = documentScanPlan.indexedExpressionsByLine[lineNumber];
            if (cachedIndexedExpressions !== undefined) return cachedIndexedExpressions;
            const escapeChar = rootCtx.resolver.ctrlCharAtLine(lineNumber);
            const indexedExpressions = collectIndexedAccessExpressionsFromLine(strippedLineText, escapeChar);
            documentScanPlan.indexedExpressionsByLine[lineNumber] = indexedExpressions;
            return indexedExpressions;
        };
        const getInlineCallsForLine = (lineNumber, strippedLineText, lineStartOffset) => {
            const cachedInlineCalls = documentScanPlan.inlineCallsByLine[lineNumber];
            if (cachedInlineCalls !== undefined) return cachedInlineCalls;
            const escapeChar = rootCtx.resolver.ctrlCharAtLine(lineNumber);
            const inlineCalls = collectInlineNamedCallContexts(strippedLineText, lineStartOffset, escapeChar, {
                includeClosedCalls: true
            });
            documentScanPlan.inlineCallsByLine[lineNumber] = inlineCalls;
            return inlineCalls;
        };
        const getLineStringStartQuote = lineNumber => {
            if (!documentScanPlan.lineStringStartQuoteCodes) {
                documentScanPlan.lineStringStartQuoteCodes = getLineStringStartQuoteCodes
                    ? getLineStringStartQuoteCodes(rootCtx)
                    : new Uint16Array(document.lineCount);
            }
            const quoteCode = documentScanPlan.lineStringStartQuoteCodes[lineNumber] || 0;
            return quoteCode ? String.fromCharCode(quoteCode) : '';
        };
        const getPackedStringDefaultForLine = lineNumber => {
            if (!documentScanPlan.packedStringDefaultLineFlags) {
                documentScanPlan.packedStringDefaultLineFlags = collectPackedStringDefaultLineFlags
                    ? collectPackedStringDefaultLineFlags(rootCtx.strippedLines || documentScanPlan.rawLines)
                    : new Uint8Array(document.lineCount);
            }
            return !!documentScanPlan.packedStringDefaultLineFlags[lineNumber];
        };
        const pushDiagnostic = diagnostic => {
            if (!diagnostic) return;
            if (!shouldKeepDiagnostic(diagnostic)) return;
            const key = makeLiveValidationDiagnosticKey(diagnostic);
            if (seen.has(key)) return;
            seen.add(key);
            diagnostics.push(diagnostic);
        };
        const isBackslashContinuationLine = lineNumber => {
            return !!documentScanPlan.backslashContinuationLines[lineNumber];
        };
        const isPreprocessorDirectiveLine = lineNumber => {
            const trimmedRawLine = String(documentScanPlan.rawLines[lineNumber] || '').trimStart();
            return trimmedRawLine.startsWith('#');
        };
        const candidateLineNumbers = (() => {
            return documentScanPlan.lineIndex.expressionCandidateLines || [];
        })();

        const inactiveStockLines = documentScanPlan.inactiveStockLines || null;
        const inactivePreprocessorLineFlags = documentScanPlan.inactivePreprocessorLineFlags || null;
        const hasInactiveStockLines = !!inactiveStockLines?.size;
        const isInactivePreprocessorLine = lineNumber =>
            !!(inactivePreprocessorLineFlags && inactivePreprocessorLineFlags[lineNumber]);
        const lineNumbers = (requestedSpecificLines || hasInactiveStockLines) ? new Set() : null;
        let orderedLineNumbers = requestedSpecificLines || hasInactiveStockLines ? [] : null;
        if (requestedSpecificLines) {
            for (const line of options.lines) {
                if (!Number.isInteger(line)) continue;
                if (line < 0 || line >= document.lineCount) continue;
                if (inactiveStockLines?.has(line)) continue;
                if (isInactivePreprocessorLine(line)) continue;
                if (lineNumbers.has(line)) continue;
                lineNumbers.add(line);
                orderedLineNumbers.push(line);
            }
            orderedLineNumbers.sort((left, right) => left - right);
        } else if (hasInactiveStockLines) {
            for (let line = 0; line < document.lineCount; line++) {
                if (inactiveStockLines.has(line)) continue;
                if (isInactivePreprocessorLine(line)) continue;
                lineNumbers.add(line);
                orderedLineNumbers.push(line);
            }
        }
        const isFullScan = !requestedSpecificLines;
        const focusLineNumbers = Array.isArray(options.focusLines) && options.focusLines.length
            ? [...new Set(options.focusLines.filter(line =>
                Number.isInteger(line) &&
                line >= 0 &&
                line < document.lineCount
            ))].sort((left, right) => left - right)
            : (orderedLineNumbers || EMPTY_DIAGNOSTICS);
        const targetLineCount = orderedLineNumbers ? orderedLineNumbers.length : document.lineCount;
        const shouldPreparseLocals = isFullScan || targetLineCount >= 320;
        if (scanStats) {
            scanStats.targetLineCount = targetLineCount;
            scanStats.lineContextCount = 0;
            scanStats.analysisCacheCount = 0;
            scanStats.indexedLineCount = 0;
            scanStats.callLineCount = 0;
            scanStats.issueMode = getLiveValidationIssueMode();
            scanStats.warningsEnabled = areLiveValidationWarningsEnabled(getLiveValidationIssueMode());
            scanStats.usageDiagnostics = 0;
            scanStats.usageDiagnosticsKept = 0;
            scanStats.candidateDiagnosticCacheHits = 0;
            scanStats.lineDiagnosticCacheHits = 0;
            scanStats.headerDiagnosticCacheHits = 0;
            scanStats.structuralDiagnosticCacheHits = 0;
        }
        const validationCacheSignature = [
            `stock:${settingsService?.getUnusedStockValidationMode?.() || 'reachable-only'}`,
            `issues:${getLiveValidationIssueMode()}`,
            `include:${settingsService?.getIncludeValidationMode?.() || 'balanced'}`,
            `callback:${settingsService?.getCallbackSignatureMode?.() || 'strict'}`,
            `locals:${shouldPreparseLocals ? 1 : 0}`
        ].join('|');
        const shouldRetainDiagnosticCaches = document.lineCount >= 800 || targetLineCount >= 320;
        const getSessionCacheForSignature = (cacheName, createCache = null) => {
            if (!shouldRetainDiagnosticCaches) return null;
            const semanticSession = rootCtx.semanticSession || null;
            return getSemanticSignatureCache(
                semanticSession,
                cacheName,
                validationCacheSignature,
                createCache || (() => cacheName === 'liveValidationHeaderDiagnosticsBySignature'
                    ? new Map()
                    : []),
                8
            );
        };
        const candidateDiagnosticsByLine = getSessionCacheForSignature('liveValidationCandidateDiagnosticsBySignature');
        const lineDiagnosticsByLine = getSessionCacheForSignature('liveValidationLineDiagnosticsBySignature');
        const headerDiagnosticsByKey = getSessionCacheForSignature('liveValidationHeaderDiagnosticsBySignature');
        const structuralDiagnosticsCache = getSessionCacheForSignature(
            'liveValidationStructuralDiagnosticsBySignature',
            () => ({})
        );
        const lineIndex = documentScanPlan.lineIndex;
        const invalidCodeCharacterCandidateLineFlags = lineIndex.invalidCodeCharacterCandidateLineFlags;
        const unknownSymbolCandidateLineFlags = lineIndex.unknownSymbolCandidateLineFlags;
        const declarationDiagnosticCandidateLineFlags = lineIndex.declarationDiagnosticCandidateLineFlags;
        const expressionOperatorCandidateLineFlags = lineIndex.expressionOperatorCandidateLineFlags;
        const strayTokenCandidateLineFlags = lineIndex.strayTokenCandidateLineFlags;
        const analysisLineNumbers = candidateLineNumbers.length
            ? (lineNumbers
                ? orderedLineNumbers.filter(line => lineIndex.expressionCandidateLineFlags?.[line])
                : candidateLineNumbers)
            : (orderedLineNumbers || EMPTY_DIAGNOSTICS);
        const generalLineNumbers = lineNumbers
            ? orderedLineNumbers.filter(line => documentScanPlan.generalDiagnosticCandidateFlags?.[line])
            : (documentScanPlan.generalDiagnosticCandidateLines || orderedLineNumbers);
        const isEnumMemberLine = lineNumber => documentScanPlan.enumMemberLines.has(lineNumber);
        const hasContextEnumMemberDeclarationOnLine = (lineCtx, lineNumber) => {
            return !!isEnumMemberDeclarationLine?.(lineCtx, lineNumber);
        };
        const findFunctionBodyRangeForLine = lineNumber => {
            return documentScanPlan.functionBodyRangeByLine[lineNumber] || null;
        };
        const computeReusableContextEndLine = (lineNumber, lineCtx) => {
            const locals = lineCtx?.parsedDecls?.locals || [];
            const funcArgs = lineCtx?.parsedDecls?.funcArgs || [];
            const bodyRange = findFunctionBodyRangeForLine(lineNumber);
            const trimmedRawLine = String(documentScanPlan.rawLines[lineNumber] || '').trim();
            if (/^[{}]+$/.test(trimmedRawLine)) {
                return lineNumber;
            }
            if (isEnumMemberLine(lineNumber)) {
                return lineNumber;
            }
            if (!bodyRange && !locals.length && !funcArgs.length) {
                const nextChangeLine = documentScanPlan.nextTopLevelContextChangeLine[lineNumber + 1] ?? document.lineCount;
                const nextBodyChangeLine = documentScanPlan.nextBodyContextChangeLine[lineNumber + 1] ?? document.lineCount;
                const nextExplicitBoundaryLine = documentScanPlan.nextExplicitContextBoundaryLine[lineNumber + 1] ?? document.lineCount;
                const nextRelevantChangeLine = Math.min(nextChangeLine, nextBodyChangeLine, nextExplicitBoundaryLine);
                if (nextRelevantChangeLine < document.lineCount) {
                    return nextRelevantChangeLine - 1;
                }
                return document.lineCount - 1;
            }

            let validThroughLine = bodyRange?.endLine ?? lineNumber;
            for (const local of locals) {
                const scopeEndLine = local.scopeEndLine ?? local.lineNumber;
                if (scopeEndLine >= lineNumber) {
                    validThroughLine = Math.min(validThroughLine, scopeEndLine);
                }
            }
            const nextChangeLine = documentScanPlan.nextBodyDeclarationContextChangeLine[lineNumber + 1] ?? document.lineCount;
            if (nextChangeLine <= validThroughLine) {
                return nextChangeLine - 1;
            }
            return validThroughLine;
        };
        const getLineContext = lineNumber => {
            if (
                sequentialScanContextState.ctx &&
                lineNumber >= sequentialScanContextState.cursorLine &&
                lineNumber <= sequentialScanContextState.validThroughLine
            ) {
                setCachedLineContext(lineNumber, sequentialScanContextState.ctx);
                return sequentialScanContextState.ctx;
            }
            const cachedCtx = getCachedLineContext(lineNumber);
            if (!isFullScan && cachedCtx !== undefined) {
                return cachedCtx;
            }
            const ctx = getDocumentContextForScan(lineNumber, {
                ephemeral: true,
                cursorCache: true,
                preparseLocals: shouldPreparseLocals
            }) || rootCtx;
            if (scanStats) scanStats.lineContextCount++;
            setCachedLineContext(lineNumber, ctx);
            sequentialScanContextState.ctx = ctx;
            sequentialScanContextState.cursorLine = lineNumber;
            sequentialScanContextState.validThroughLine = computeReusableContextEndLine(lineNumber, ctx);
            return ctx;
        };
        const getAnalysisCacheForLine = (lineNumber, providedCtx = null) => {
            const cachedAnalysisForLine = lineAnalysisCache[lineNumber];
            if (cachedAnalysisForLine !== undefined) return cachedAnalysisForLine;
            const lineCtx = providedCtx || getLineContext(lineNumber);
            const parsedDeclsKey = lineCtx?.parsedDecls;
            const hadAnalysisCache = !!(parsedDeclsKey && analysisCacheByParsedDecls.has(parsedDeclsKey));
            const analysisCache = getSemanticAnalysisCache(
                semanticSessionForAnalysis,
                parsedDeclsKey,
                lineCtx.lookup,
                createHoverTypeAnalysisCache
            );
            if (!hadAnalysisCache && scanStats) {
                scanStats.analysisCacheCount++;
            }
            lineAnalysisCache[lineNumber] = analysisCache;
            return analysisCache;
        };
        const collectCandidateDiagnosticsForLine = lineNumber => {
            if (candidateDiagnosticsByLine) {
                const cachedDiagnostics = candidateDiagnosticsByLine[lineNumber];
                if (cachedDiagnostics !== undefined) {
                    if (scanStats) scanStats.candidateDiagnosticCacheHits++;
                    return cachedDiagnostics;
                }
            }

            let lineDiagnostics = null;
            const addCandidateDiagnostic = diagnostic => {
                if (!diagnostic) return;
                if (!lineDiagnostics) lineDiagnostics = [];
                lineDiagnostics.push(diagnostic);
            };
            const { text: lineText, startOffset: lineStartOffset } = getValidationLineSnapshot(lineNumber);
            const strippedLineText = rootCtx.strippedLines?.[lineNumber] ?? lineText;
            const mayContainIndexedAccess = strippedLineText.includes('[');
            let indexedExpressions = null;
            if (mayContainIndexedAccess) {
                const detectedIndexedExpressions = getIndexedExpressionsForLine(lineNumber, strippedLineText);
                if (detectedIndexedExpressions.length) {
                    indexedExpressions = detectedIndexedExpressions;
                }
            }
            let inlineCalls = null;
            if (strippedLineText.includes('(')) {
                const detectedInlineCalls = getInlineCallsForLine(lineNumber, strippedLineText, lineStartOffset);
                if (detectedInlineCalls.length) {
                    inlineCalls = detectedInlineCalls;
                }
            }
            let lineCtx = null;
            let analysisCache = null;

            if (indexedExpressions || inlineCalls) {
                lineCtx = getLineContext(lineNumber);
                analysisCache = getAnalysisCacheForLine(lineNumber, lineCtx);
            }

            if (lineCtx && hasContextEnumMemberDeclarationOnLine(lineCtx, lineNumber)) {
                if (candidateDiagnosticsByLine) candidateDiagnosticsByLine[lineNumber] = EMPTY_DIAGNOSTICS;
                return EMPTY_DIAGNOSTICS;
            }

            if (indexedExpressions && lineCtx && analysisCache) {
                if (scanStats) scanStats.indexedLineCount++;
                for (const diagnostic of collectIndexedAccessLiveDiagnosticsForLine(document, lineNumber, lineCtx, analysisCache, lineStartOffset, docLength, declarationSourceState, indexedExpressions)) {
                    addCandidateDiagnostic(diagnostic);
                }
            }

            if (inlineCalls && lineCtx && analysisCache) {
                if (scanStats) scanStats.callLineCount++;
                for (const callCtx of inlineCalls) {
                    for (const diagnostic of collectCallLiveDiagnostics(document, lineCtx, callCtx, analysisCache, docLength, lineNumber)) {
                        addCandidateDiagnostic(diagnostic);
                    }
                }
            }

            const result = lineDiagnostics || EMPTY_DIAGNOSTICS;
            if (candidateDiagnosticsByLine) candidateDiagnosticsByLine[lineNumber] = result;
            return result;
        };
        const collectGeneralDiagnosticsForLine = lineNumber => {
            if (lineDiagnosticsByLine) {
                const cachedDiagnostics = lineDiagnosticsByLine[lineNumber];
                if (cachedDiagnostics !== undefined) {
                    if (scanStats) scanStats.lineDiagnosticCacheHits++;
                    return cachedDiagnostics;
                }
            }

            let lineDiagnostics = null;
            const addLineDiagnostic = diagnostic => {
                if (!diagnostic) return;
                if (!lineDiagnostics) lineDiagnostics = [];
                lineDiagnostics.push(diagnostic);
            };
            const { text: lineText, startOffset: lineStartOffset } = getValidationLineSnapshot(lineNumber);
            const strippedLineText = rootCtx.strippedLines?.[lineNumber] ?? lineText;
            const trimmedStrippedLineText = String(strippedLineText || '').trim();
            if (!trimmedStrippedLineText) {
                if (lineDiagnosticsByLine) lineDiagnosticsByLine[lineNumber] = EMPTY_DIAGNOSTICS;
                return EMPTY_DIAGNOSTICS;
            }
            const mayNeedUnknownSymbolValidation = !!unknownSymbolCandidateLineFlags[lineNumber];
            const mayNeedDeclarationValidation = !!declarationDiagnosticCandidateLineFlags[lineNumber];
            const mayNeedExpressionOperatorValidation = !!expressionOperatorCandidateLineFlags[lineNumber];
            const mayNeedStrayTokenValidation = !!strayTokenCandidateLineFlags[lineNumber];
            if (
                !mayNeedUnknownSymbolValidation &&
                !mayNeedDeclarationValidation &&
                !mayNeedExpressionOperatorValidation &&
                !mayNeedStrayTokenValidation
            ) {
                if (lineDiagnosticsByLine) lineDiagnosticsByLine[lineNumber] = EMPTY_DIAGNOSTICS;
                return EMPTY_DIAGNOSTICS;
            }
            if (isEnumMemberLine(lineNumber)) {
                if (lineDiagnosticsByLine) lineDiagnosticsByLine[lineNumber] = EMPTY_DIAGNOSTICS;
                return EMPTY_DIAGNOSTICS;
            }
            let lineCtx = null;
            let isContextEnumMemberLine = false;
            const getGeneralLineContext = () => {
                if (lineCtx) return lineCtx;
                lineCtx = getLineContext(lineNumber) || getCachedLineContext(lineNumber) || rootCtx;
                setCachedLineContext(lineNumber, lineCtx);
                isContextEnumMemberLine = hasContextEnumMemberDeclarationOnLine(lineCtx, lineNumber);
                return lineCtx;
            };
            const shouldSkipContextDiagnostics = () => {
                getGeneralLineContext();
                if (!isContextEnumMemberLine) return false;
                if (lineDiagnosticsByLine) lineDiagnosticsByLine[lineNumber] = EMPTY_DIAGNOSTICS;
                return true;
            };
            if (mayNeedUnknownSymbolValidation) {
                if (shouldSkipContextDiagnostics()) return EMPTY_DIAGNOSTICS;
                const ctx = getGeneralLineContext();
                for (const diagnostic of collectUnknownSymbolLiveDiagnosticsForLine(
                    document,
                    lineNumber,
                    ctx,
                    () => getAnalysisCacheForLine(lineNumber, ctx),
                    lineText,
                    strippedLineText,
                    lineStartOffset,
                    docLength,
                    declarationSourceState,
                    unknownSymbolLookupState
                )) {
                    addLineDiagnostic(diagnostic);
                }
            }
            if (mayNeedStrayTokenValidation) {
                if (shouldSkipContextDiagnostics()) return EMPTY_DIAGNOSTICS;
                const ctx = getGeneralLineContext();
                for (const diagnostic of collectStrayTokenLiveDiagnosticsForLine(
                    document,
                    lineNumber,
                    ctx,
                    lineText,
                    strippedLineText,
                    rootCtx.strippedLines || documentScanPlan.rawLines,
                    lineStartOffset,
                    docLength
                )) {
                    addLineDiagnostic(diagnostic);
                }
            }
            if (mayNeedDeclarationValidation) {
                if (shouldSkipContextDiagnostics()) return EMPTY_DIAGNOSTICS;
                const ctx = getGeneralLineContext();
                for (const diagnostic of collectDeclarationLiveDiagnosticsForLine(
                    document,
                    lineNumber,
                    ctx,
                    lineText,
                    strippedLineText,
                    lineStartOffset,
                    docLength,
                    () => getAnalysisCacheForLine(lineNumber, ctx)
                )) {
                    addLineDiagnostic(diagnostic);
                }
            }
            if (mayNeedExpressionOperatorValidation) {
                const expressionCtx = /\bsizeof\b/.test(trimmedStrippedLineText)
                    ? getGeneralLineContext()
                    : (lineCtx || rootCtx);
                if (isContextEnumMemberLine) {
                    if (lineDiagnosticsByLine) lineDiagnosticsByLine[lineNumber] = EMPTY_DIAGNOSTICS;
                    return EMPTY_DIAGNOSTICS;
                }
                for (const diagnostic of collectExpressionOperatorLiveDiagnosticsForLine(
                    document,
                    lineNumber,
                    expressionCtx,
                    lineText,
                    strippedLineText,
                    lineStartOffset,
                    docLength
                )) {
                    addLineDiagnostic(diagnostic);
                }
            }
            const result = lineDiagnostics || EMPTY_DIAGNOSTICS;
            if (lineDiagnosticsByLine) lineDiagnosticsByLine[lineNumber] = result;
            return result;
        };
        const collectHeaderDiagnosticsForFunction = func => {
            const headerEndLine = func.headerEndLine ?? func.startLine;
            const headerKey = `${func.name}|${func.startLine}|${headerEndLine}`;
            if (headerDiagnosticsByKey?.has(headerKey)) {
                if (scanStats) scanStats.headerDiagnosticCacheHits++;
                return headerDiagnosticsByKey.get(headerKey) || [];
            }
            const headerCtx = getLineContext(func.startLine);
            const headerAnalysisCache = getAnalysisCacheForLine(func.startLine, headerCtx);
            let diagnosticsForHeader = null;
            for (const diagnostic of collectHeaderLiveDiagnostics(document, headerCtx, func, headerAnalysisCache, docLength)) {
                if (!diagnostic) continue;
                if (!diagnosticsForHeader) diagnosticsForHeader = [];
                diagnosticsForHeader.push(diagnostic);
            }
            const result = diagnosticsForHeader || EMPTY_DIAGNOSTICS;
            headerDiagnosticsByKey?.set(headerKey, result);
            return result;
        };

        const getDelimiterBalanceState = () => {
            if (documentScanPlan.delimiterBalanceState) {
                return documentScanPlan.delimiterBalanceState;
            }
            const state = collectDelimiterBalanceState(
                document,
                rootCtx.strippedLines || documentScanPlan.rawLines,
                documentScanPlan.lineCtrlChars,
                docLength,
                null,
                { lineStartOffsets: getLineStartOffsets() }
            );
            documentScanPlan.delimiterBalanceState = state;
            return state;
        };
        const delimiterState = getDelimiterBalanceState();
        const delimiterTaintedLines = delimiterState?.taintedLines || null;
        const isDelimiterTaintedLine = lineNumber => !!delimiterTaintedLines?.[lineNumber];
        const delimiterDiagnostics = lineNumbers
            ? (delimiterState.diagnostics || EMPTY_DIAGNOSTICS).filter(diagnostic =>
                lineNumbers.has(diagnostic?.range?.start?.line)
            )
            : (delimiterState.diagnostics || EMPTY_DIAGNOSTICS);
        for (const diagnostic of delimiterDiagnostics) {
            if (isInactivePreprocessorLine(diagnostic?.range?.start?.line)) continue;
            pushDiagnostic(diagnostic);
        }
        for (const diagnostic of collectPreprocessorAndLabelLiveDiagnostics(
            document,
            rootCtx,
            docLength,
            lineNumbers
        )) {
            if (isInactivePreprocessorLine(diagnostic.range.start.line)) continue;
            if (isDelimiterTaintedLine(diagnostic.range.start.line)) continue;
            pushDiagnostic(diagnostic);
        }
        if (typeof collectUsageLiveDiagnostics === 'function') {
            const usageDiagnostics = collectUsageLiveDiagnostics(document, rootCtx, docLength);
            if (scanStats) {
                scanStats.usageDiagnostics = usageDiagnostics.length;
            }
            for (const diagnostic of usageDiagnostics) {
                if (isInactivePreprocessorLine(diagnostic.range.start.line)) continue;
                if (isDelimiterTaintedLine(diagnostic.range.start.line)) continue;
                const before = diagnostics.length;
                pushDiagnostic(diagnostic);
                if (scanStats && diagnostics.length > before) {
                    scanStats.usageDiagnosticsKept++;
                }
            }
        }
        if (typeof collectDynamicUsageLiveDiagnostics === 'function') {
            for (const diagnostic of collectDynamicUsageLiveDiagnostics(document, rootCtx, docLength, {
                inactiveStockLines: documentScanPlan.inactiveStockLines || null
            })) {
                if (isInactivePreprocessorLine(diagnostic.range.start.line)) continue;
                if (isDelimiterTaintedLine(diagnostic.range.start.line)) continue;
                pushDiagnostic(diagnostic);
            }
        }
        if (typeof collectMultilinePawnStringLiteralDiagnostics === 'function') {
            for (const diagnostic of collectMultilinePawnStringLiteralDiagnostics(document, rootCtx, docLength, {
                lineCtrlChars: documentScanPlan.lineCtrlChars,
                packedStringDefaultLineFlags: (() => {
                    if (!documentScanPlan.packedStringDefaultLineFlags) {
                        documentScanPlan.packedStringDefaultLineFlags = collectPackedStringDefaultLineFlags
                            ? collectPackedStringDefaultLineFlags(rootCtx.strippedLines || documentScanPlan.rawLines)
                            : new Uint8Array(document.lineCount);
                    }
                    return documentScanPlan.packedStringDefaultLineFlags;
                })(),
                targetLineNumbers: lineNumbers
            })) {
                if (isInactivePreprocessorLine(diagnostic.range.start.line)) continue;
                if (isDelimiterTaintedLine(diagnostic.range.start.line)) continue;
                pushDiagnostic(diagnostic);
            }
        }

        const diagnosticLinePlan = lineNumbers
            ? buildDiagnosticLinePlan(document.lineCount, analysisLineNumbers, generalLineNumbers)
            : (documentScanPlan.fullDiagnosticLinePlan ||= buildDiagnosticLinePlan(
                document.lineCount,
                analysisLineNumbers,
                generalLineNumbers
            ));
        const {
            analysisLineFlags,
            generalLineFlags,
            combinedDiagnosticLineNumbers
        } = diagnosticLinePlan;

        for (const lineNumber of combinedDiagnosticLineNumbers) {
            if (isInactivePreprocessorLine(lineNumber)) continue;
            let lineHasInvalidCodeCharacters = false;
            let firstInvalidCodeCharacter = -1;
            if (
                invalidCodeCharacterCandidateLineFlags[lineNumber]
            ) {
                const { text: lineText, startOffset: lineStartOffset } = getValidationLineSnapshot(lineNumber);
                const strippedLineText = rootCtx.strippedLines?.[lineNumber] ?? lineText;
                const escapeChar = rootCtx.resolver?.ctrlCharAtLine?.(lineNumber) ||
                    documentScanPlan.lineCtrlChars?.[lineNumber] ||
                    '';
                const invalidCodeCharacterDiagnostics = collectInvalidPawnCodeCharacterDiagnosticsForLine(
                    document,
                    lineNumber,
                    lineText,
                    strippedLineText,
                    lineStartOffset,
                    docLength,
                    escapeChar,
                    {
                        initialQuote: getLineStringStartQuote(lineNumber),
                        defaultPackedString: getPackedStringDefaultForLine(lineNumber)
                    }
                );
                for (const diagnostic of invalidCodeCharacterDiagnostics) {
                    pushDiagnostic(diagnostic);
                    const startCharacter = diagnostic?.range?.start?.line === lineNumber
                        ? diagnostic.range.start.character
                        : -1;
                    if (
                        Number.isInteger(startCharacter) &&
                        startCharacter >= 0 &&
                        (firstInvalidCodeCharacter < 0 || startCharacter < firstInvalidCodeCharacter)
                    ) {
                        firstInvalidCodeCharacter = startCharacter;
                    }
                }
                lineHasInvalidCodeCharacters = invalidCodeCharacterDiagnostics.length > 0;
            }
            if (isDelimiterTaintedLine(lineNumber)) continue;
            if (isBackslashContinuationLine(lineNumber)) continue;
            if (isEnumMemberLine(lineNumber)) continue;
            if (documentScanPlan.functionHeaderLines?.has(lineNumber)) continue;
            if (analysisLineFlags[lineNumber] && !isPreprocessorDirectiveLine(lineNumber)) {
                for (const diagnostic of collectCandidateDiagnosticsForLine(lineNumber)) {
                    if (
                        lineHasInvalidCodeCharacters &&
                        diagnostic?.range?.start?.line === lineNumber &&
                        diagnostic?.range?.end?.line === lineNumber &&
                        diagnostic.range.end.character >= firstInvalidCodeCharacter
                    ) {
                        continue;
                    }
                    pushDiagnostic(diagnostic);
                }
            }
            if (generalLineFlags[lineNumber] && !lineHasInvalidCodeCharacters) {
                for (const diagnostic of collectGeneralDiagnosticsForLine(lineNumber)) {
                    pushDiagnostic(diagnostic);
                }
            }
        }

        if (!isFullScan) {
            const touchedFunctions = new Set();
            for (const lineNumber of focusLineNumbers) {
                if (isDelimiterTaintedLine(lineNumber)) continue;
                const { text: lineText } = getValidationLineSnapshot(lineNumber);
                const probePosition = new vscode.Position(lineNumber, lineText.length);
                if (lineText.includes('(')) {
                    const lineCtx = getLineContext(lineNumber);
                    const enclosingCallCtx = findPreferredKnownCallContext(
                        document,
                        probePosition,
                        lineCtx.parsedDecls.functions,
                        lineCtx.incDecls,
                        lineCtx.lookup,
                        callContextOptions
                    );
                    if (enclosingCallCtx) {
                        const analysisCache = getAnalysisCacheForLine(lineNumber, lineCtx);
                        for (const diagnostic of collectCallLiveDiagnostics(document, lineCtx, enclosingCallCtx, analysisCache, docLength, lineNumber)) {
                            pushDiagnostic(diagnostic);
                        }
                    }
                }

                const headerFuncsForLine = headerCandidateMeta.byLine.get(lineNumber) || [];
                for (const func of headerFuncsForLine) {
                    if (documentScanPlan.inactiveStockLines?.has(func.startLine)) continue;
                    const headerEndLine = func.headerEndLine ?? func.startLine;
                    const funcKey = `${func.name}|${func.startLine}|${headerEndLine}`;
                    if (touchedFunctions.has(funcKey)) continue;
                    touchedFunctions.add(funcKey);
                    if (isDelimiterTaintedLine(func.startLine)) continue;
                    for (const diagnostic of collectHeaderDiagnosticsForFunction(func)) {
                        pushDiagnostic(diagnostic);
                    }
                }
            }
        } else {
            for (const func of headerCandidateFunctions) {
                if (documentScanPlan.inactiveStockLines?.has(func.startLine)) continue;
                if (isDelimiterTaintedLine(func.startLine)) continue;
                for (const diagnostic of collectHeaderDiagnosticsForFunction(func)) {
                    pushDiagnostic(diagnostic);
                }
            }
        }

        const collectStructuralDiagnosticsForScan = () => {
            if (
                isFullScan &&
                structuralDiagnosticsCache &&
                structuralDiagnosticsCache.fullDiagnostics !== undefined
            ) {
                if (scanStats) scanStats.structuralDiagnosticCacheHits++;
                return structuralDiagnosticsCache.fullDiagnostics || EMPTY_DIAGNOSTICS;
            }
            const result = collectStructuralLiveDiagnostics(
                document,
                rootCtx,
                docLength,
                lineNumbers,
                {
                    getLineContext,
                    getAnalysisCacheForLine
                }
            );
            if (isFullScan && structuralDiagnosticsCache) {
                structuralDiagnosticsCache.fullDiagnostics = result?.length ? result : EMPTY_DIAGNOSTICS;
            }
            return result;
        };
        for (const diagnostic of collectStructuralDiagnosticsForScan()) {
            if (isDelimiterTaintedLine(diagnostic.range.start.line)) continue;
            pushDiagnostic(diagnostic);
        }

        return diagnostics;
    }

    return {
        collectLiveValidationDiagnostics
    };
}

module.exports = { createLiveValidationScanner };
