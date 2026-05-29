const { createUtilityCore } = require('../../core/utils/runtime');
const {
    createDocumentScanPlanBuilder,
    buildDiagnosticLinePlan
} = require('./scan-plan');
const {
    getSemanticSignatureCache,
    getSemanticAnalysisCache
} = require('../../core/document-context/semantic-session');
const {
    LIVE_INVALID_CODE_CHARACTER_DIAGNOSTIC_CODE,
    LIVE_UNRESOLVED_INCLUDE_DIAGNOSTIC_CODE
} = require('./diagnostic-codes');
const {
    LIVE_VALIDATION_DIAGNOSTIC_ENGINE_SIGNATURE
} = require('./diagnostic-engine-signature');
const { createScannerLineState } = require('./scanner-state');
const {
    createLiveDiagnosticLineFilter,
    getDiagnosticLineSpan,
    getDiagnosticStartLine,
    getSingleLineDiagnosticRange,
    isSingleLineDiagnostic
} = require('./diagnostic-line-filter');
const { toSortedUniqueLineNumbers } = require('../../core/syntax/line-number-lists');
const { isPreprocessorDirectiveLine: isPreprocessorDirectiveTextLine } = require('../../core/syntax/preprocessor-lines');

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

    function collectLiveValidationDiagnostics(document, options = {}) {
        const requestedSpecificLines = Array.isArray(options.lines) && options.lines.length;
        const isFullScanRequest = !requestedSpecificLines;
        const issueMode = getLiveValidationIssueMode();
        const warningsEnabledForScan = areLiveValidationWarningsEnabled(issueMode);
        const shouldKeepDiagnostic = diagnostic =>
            warningsEnabledForScan ||
            diagnostic?.severity === vscode?.DiagnosticSeverity?.Error ||
            diagnostic?.severity == null;
        const shouldPreparseUsageLocals = warningsEnabledForScan;
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
        const invalidCodeCharacterRangesByLine = new Map();
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
        const {
            getLineStartOffsets,
            getValidationLineSnapshot,
            getIndexedExpressionsForLine,
            getInlineCallsForLine
        } = createScannerLineState({
            document,
            rootCtx,
            documentScanPlan,
            collectIndexedAccessExpressionsFromLine,
            collectInlineNamedCallContexts
        });
        const getLineStringStartQuote = lineNumber => {
            if (!documentScanPlan.lineStringStartQuoteCodes) {
                documentScanPlan.lineStringStartQuoteCodes = getLineStringStartQuoteCodes(rootCtx);
            }
            const quoteCode = documentScanPlan.lineStringStartQuoteCodes[lineNumber] || 0;
            return quoteCode ? String.fromCharCode(quoteCode) : '';
        };
        const getPackedStringDefaultForLine = lineNumber => {
            if (!documentScanPlan.packedStringDefaultLineFlags) {
                documentScanPlan.packedStringDefaultLineFlags = collectPackedStringDefaultLineFlags(
                    rootCtx.strippedLines || documentScanPlan.rawLines
                );
            }
            return !!documentScanPlan.packedStringDefaultLineFlags[lineNumber];
        };
        const rangesOverlap = (leftStart, leftEnd, rightStart, rightEnd) =>
            leftStart < rightEnd && rightStart < leftEnd;
        const isInvalidCodeCharacterDiagnostic = diagnostic =>
            diagnostic?.code === LIVE_INVALID_CODE_CHARACTER_DIAGNOSTIC_CODE;
        const diagnosticOverlapsInvalidCodeCharacter = diagnostic => {
            if (!diagnostic?.range?.start || !diagnostic?.range?.end) return false;
            if (isInvalidCodeCharacterDiagnostic(diagnostic)) return false;
            if (!isSingleLineDiagnostic(diagnostic)) return false;
            const { startLine } = getDiagnosticLineSpan(diagnostic);
            const invalidRanges = invalidCodeCharacterRangesByLine.get(startLine);
            if (!invalidRanges?.length) return false;
            return invalidRanges.some(range =>
                rangesOverlap(
                    diagnostic.range.start.character,
                    diagnostic.range.end.character,
                    range.start,
                    range.end
                )
            );
        };
        const rememberInvalidCodeCharacterRange = diagnostic => {
            const range = getSingleLineDiagnosticRange(diagnostic);
            if (!range) return;
            const lineNumber = getDiagnosticStartLine(diagnostic);
            const lineRanges = invalidCodeCharacterRangesByLine.get(lineNumber) || [];
            lineRanges.push({
                start: range.start.character,
                end: Math.max(range.start.character + 1, range.end.character)
            });
            invalidCodeCharacterRangesByLine.set(lineNumber, lineRanges);
        };
        const removeDiagnosticsOverlappingInvalidCodeCharacter = invalidDiagnostic => {
            const range = getSingleLineDiagnosticRange(invalidDiagnostic);
            if (!range) return;
            const lineNumber = getDiagnosticStartLine(invalidDiagnostic);
            for (let index = diagnostics.length - 1; index >= 0; index--) {
                const diagnostic = diagnostics[index];
                if (isInvalidCodeCharacterDiagnostic(diagnostic)) continue;
                if (getDiagnosticStartLine(diagnostic) !== lineNumber) continue;
                if (!isSingleLineDiagnostic(diagnostic)) continue;
                if (!rangesOverlap(
                    diagnostic.range.start.character,
                    diagnostic.range.end.character,
                    range.start.character,
                    range.end.character
                )) {
                    continue;
                }
                seen.delete(makeLiveValidationDiagnosticKey(diagnostic));
                diagnostics.splice(index, 1);
            }
        };
        const pushDiagnostic = diagnostic => {
            if (!diagnostic) return;
            if (!shouldKeepDiagnostic(diagnostic)) return;
            if (isInvalidCodeCharacterDiagnostic(diagnostic)) {
                rememberInvalidCodeCharacterRange(diagnostic);
                removeDiagnosticsOverlappingInvalidCodeCharacter(diagnostic);
            } else if (diagnosticOverlapsInvalidCodeCharacter(diagnostic)) {
                return;
            }
            const key = makeLiveValidationDiagnosticKey(diagnostic);
            if (seen.has(key)) return;
            seen.add(key);
            diagnostics.push(diagnostic);
        };
        const isBackslashContinuationLine = lineNumber => {
            return !!documentScanPlan.backslashContinuationLines[lineNumber];
        };
        const isPreprocessorDirectiveLine = lineNumber => {
            const lineIndex = documentScanPlan.lineIndex;
            if (typeof lineIndex?.isPreprocessorDirectiveLine === 'function') {
                return lineIndex.isPreprocessorDirectiveLine(lineNumber);
            }
            return isPreprocessorDirectiveTextLine(documentScanPlan.rawLines[lineNumber]);
        };
        let sequentialContextBarrierPrefix = null;
        const getSequentialContextBarrierPrefix = () => {
            if (sequentialContextBarrierPrefix) return sequentialContextBarrierPrefix;
            const lineCount = document.lineCount;
            const prefix = new Uint32Array(lineCount + 1);
            for (let lineNumber = 0; lineNumber < lineCount; lineNumber++) {
                const hasBarrier = (
                    isPreprocessorDirectiveLine(lineNumber) ||
                    (lineNumber > 0 && isPreprocessorDirectiveLine(lineNumber - 1)) ||
                    documentScanPlan.functionHeaderLines?.has(lineNumber) ||
                    (lineNumber > 0 && documentScanPlan.functionHeaderLines?.has(lineNumber - 1))
                );
                prefix[lineNumber + 1] = prefix[lineNumber] + (hasBarrier ? 1 : 0);
            }
            sequentialContextBarrierPrefix = prefix;
            return prefix;
        };
        const hasSequentialContextBarrier = (fromLine, toLine) => {
            const startLine = Math.max(0, fromLine + 1);
            const endLine = Math.min(document.lineCount - 1, toLine);
            if (endLine < startLine) return false;
            const prefix = getSequentialContextBarrierPrefix();
            return prefix[endLine + 1] > prefix[startLine];
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
            for (const line of toSortedUniqueLineNumbers(document.lineCount, options.lines)) {
                if (inactiveStockLines?.has(line)) continue;
                if (isInactivePreprocessorLine(line)) continue;
                lineNumbers.add(line);
                orderedLineNumbers.push(line);
            }
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
            ? toSortedUniqueLineNumbers(document.lineCount, options.focusLines)
            : (orderedLineNumbers || EMPTY_DIAGNOSTICS);
        const targetLineCount = orderedLineNumbers ? orderedLineNumbers.length : document.lineCount;
        const shouldPreparseLocals = isFullScan || targetLineCount >= 320;
        if (scanStats) {
            scanStats.targetLineCount = targetLineCount;
            scanStats.lineContextCount = 0;
            scanStats.analysisCacheCount = 0;
            scanStats.indexedLineCount = 0;
            scanStats.callLineCount = 0;
            scanStats.issueMode = issueMode;
            scanStats.warningsEnabled = warningsEnabledForScan;
            scanStats.usageDiagnostics = 0;
            scanStats.usageDiagnosticsKept = 0;
            scanStats.candidateDiagnosticCacheHits = 0;
            scanStats.lineDiagnosticCacheHits = 0;
            scanStats.headerDiagnosticCacheHits = 0;
            scanStats.structuralDiagnosticCacheHits = 0;
        }
        const validationCacheSignature = [
            LIVE_VALIDATION_DIAGNOSTIC_ENGINE_SIGNATURE,
            `stock:${settingsService?.getUnusedStockValidationMode?.() || 'reachable-only'}`,
            `issues:${issueMode}`,
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
        const invalidCodeCharacterLineStates = new Map();
        const collectInvalidCodeCharacterDiagnosticsForLineNumber = lineNumber => {
            if (invalidCodeCharacterLineStates.has(lineNumber)) {
                return invalidCodeCharacterLineStates.get(lineNumber);
            }
            const state = {
                diagnostics: EMPTY_DIAGNOSTICS,
                firstCharacter: -1
            };
            if (
                invalidCodeCharacterCandidateLineFlags[lineNumber] &&
                !isInactivePreprocessorLine(lineNumber)
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
                if (invalidCodeCharacterDiagnostics.length) {
                    state.diagnostics = invalidCodeCharacterDiagnostics;
                    for (const diagnostic of invalidCodeCharacterDiagnostics) {
                        const startCharacter = getDiagnosticStartLine(diagnostic) === lineNumber
                            ? diagnostic.range.start.character
                            : -1;
                        if (
                            Number.isInteger(startCharacter) &&
                            startCharacter >= 0 &&
                            (state.firstCharacter < 0 || startCharacter < state.firstCharacter)
                        ) {
                            state.firstCharacter = startCharacter;
                        }
                    }
                }
            }
            invalidCodeCharacterLineStates.set(lineNumber, state);
            return state;
        };
        const invalidCodeCharacterLineNumbers = lineNumbers
            ? orderedLineNumbers.filter(line => invalidCodeCharacterCandidateLineFlags[line])
            : (lineIndex.invalidCodeCharacterCandidateLines || EMPTY_DIAGNOSTICS);
        for (const lineNumber of invalidCodeCharacterLineNumbers) {
            const state = collectInvalidCodeCharacterDiagnosticsForLineNumber(lineNumber);
            for (const diagnostic of state.diagnostics) {
                pushDiagnostic(diagnostic);
            }
        }
        const isEnumMemberLine = lineNumber => documentScanPlan.enumMemberLines.has(lineNumber);
        const hasContextEnumMemberDeclarationOnLine = (lineCtx, lineNumber) => {
            return !!isEnumMemberDeclarationLine(lineCtx, lineNumber);
        };
        const macroProvidedLocalLineFlagsByParsedDecls = new WeakMap();
        const hasMacroProvidedLocalDeclarationOnLine = (lineCtx, lineNumber) => {
            const parsedDecls = lineCtx?.parsedDecls || null;
            if (!parsedDecls) return false;
            let flags = macroProvidedLocalLineFlagsByParsedDecls.get(parsedDecls);
            if (flags === undefined) {
                flags = null;
                for (const local of parsedDecls.locals || []) {
                    if (!local?.macroForVar) continue;
                    if (!flags) flags = new Uint8Array(document.lineCount);
                    const line = local.lineNumber;
                    if (line >= 0 && line < document.lineCount) flags[line] = 1;
                }
                macroProvidedLocalLineFlagsByParsedDecls.set(parsedDecls, flags);
            }
            return !!flags?.[lineNumber];
        };
        const findFunctionBodyRangeForLine = lineNumber => {
            return documentScanPlan.functionBodyRangeByLine[lineNumber] || null;
        };
        const isOnlyBraceLineText = text => {
            if (!text) return false;
            for (let index = 0; index < text.length; index++) {
                const code = text.charCodeAt(index);
                if (code !== 123 && code !== 125) return false;
            }
            return true;
        };
        const computeReusableContextEndLine = (lineNumber, lineCtx) => {
            const locals = lineCtx?.parsedDecls?.locals || [];
            const funcArgs = lineCtx?.parsedDecls?.funcArgs || [];
            const bodyRange = findFunctionBodyRangeForLine(lineNumber);
            const trimmedRawLine = String(documentScanPlan.rawLines[lineNumber] || '').trim();
            if (isOnlyBraceLineText(trimmedRawLine)) {
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
            if (!bodyRange) {
                return lineNumber;
            }

            let validThroughLine = bodyRange.endLine;
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
                lineNumber <= sequentialScanContextState.validThroughLine &&
                !hasSequentialContextBarrier(sequentialScanContextState.cursorLine, lineNumber)
            ) {
                setCachedLineContext(lineNumber, sequentialScanContextState.ctx);
                return sequentialScanContextState.ctx;
            }
            const cachedCtx = getCachedLineContext(lineNumber);
            if (cachedCtx !== undefined) {
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
            if (analysisCache?.setSourceSnapshot && !analysisCache.sourceText) {
                analysisCache.setSourceSnapshot({
                    filePath: lineCtx.fp || rootCtx.fp || document.fileName,
                    text: lineCtx.text || rootCtx.text || document.getText(),
                    rawLines: lineCtx.rawLines || rootCtx.rawLines || documentScanPlan.rawLines
                });
            }
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

            if (lineCtx && hasMacroProvidedLocalDeclarationOnLine(lineCtx, lineNumber)) {
                if (candidateDiagnosticsByLine) candidateDiagnosticsByLine[lineNumber] = EMPTY_DIAGNOSTICS;
                return EMPTY_DIAGNOSTICS;
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
            const { text: lineText, startOffset: lineStartOffset } = getValidationLineSnapshot(lineNumber);
            const strippedLineText = rootCtx.strippedLines?.[lineNumber] ?? lineText;
            const trimmedStrippedLineText = String(strippedLineText || '').trim();
            if (!trimmedStrippedLineText) {
                if (lineDiagnosticsByLine) lineDiagnosticsByLine[lineNumber] = EMPTY_DIAGNOSTICS;
                return EMPTY_DIAGNOSTICS;
            }
            if (isEnumMemberLine(lineNumber)) {
                if (lineDiagnosticsByLine) lineDiagnosticsByLine[lineNumber] = EMPTY_DIAGNOSTICS;
                return EMPTY_DIAGNOSTICS;
            }
            let lineCtx = null;
            let isContextEnumMemberLine = false;
            let isMacroLocalDeclarationLine = false;
            const getGeneralLineContext = () => {
                if (lineCtx) return lineCtx;
                lineCtx = getLineContext(lineNumber) || getCachedLineContext(lineNumber) || rootCtx;
                setCachedLineContext(lineNumber, lineCtx);
                isContextEnumMemberLine = hasContextEnumMemberDeclarationOnLine(lineCtx, lineNumber);
                isMacroLocalDeclarationLine = hasMacroProvidedLocalDeclarationOnLine(lineCtx, lineNumber);
                return lineCtx;
            };
            const shouldSkipContextDiagnostics = () => {
                getGeneralLineContext();
                if (!isContextEnumMemberLine) return false;
                if (lineDiagnosticsByLine) lineDiagnosticsByLine[lineNumber] = EMPTY_DIAGNOSTICS;
                return true;
            };
            const shouldSkipMacroRawLineDiagnostics = () => {
                getGeneralLineContext();
                return isMacroLocalDeclarationLine;
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
            if (mayNeedStrayTokenValidation && !shouldSkipMacroRawLineDiagnostics()) {
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
            if (mayNeedDeclarationValidation && !shouldSkipMacroRawLineDiagnostics()) {
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
            if (mayNeedExpressionOperatorValidation && !shouldSkipMacroRawLineDiagnostics()) {
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
        const hasDelimiterDiagnostics = !!(delimiterState?.diagnostics || EMPTY_DIAGNOSTICS).length;
        const isDelimiterTaintedLine = lineNumber => !!delimiterTaintedLines?.[lineNumber];
        const diagnosticLineFilter = createLiveDiagnosticLineFilter({
            isInactivePreprocessorLine,
            isDelimiterTaintedLine
        });
        const shouldSkipDiagnosticLine = diagnosticLineFilter.shouldSkipDiagnostic;
        const shouldSkipInactiveDiagnosticLine = diagnosticLineFilter.shouldSkipInactiveDiagnostic;
        const shouldSkipInactiveLine = diagnosticLineFilter.shouldSkipInactiveLine;
        const shouldSkipTaintedLine = diagnosticLineFilter.shouldSkipTaintedLine;
        const delimiterDiagnostics = lineNumbers
            ? (delimiterState.diagnostics || EMPTY_DIAGNOSTICS).filter(diagnostic =>
                lineNumbers.has(getDiagnosticStartLine(diagnostic))
            )
            : (delimiterState.diagnostics || EMPTY_DIAGNOSTICS);
        for (const diagnostic of delimiterDiagnostics) {
            if (shouldSkipInactiveDiagnosticLine(diagnostic)) continue;
            pushDiagnostic(diagnostic);
        }
        let hasUnresolvedRequiredIncludes = (rootCtx.preprocessedState?.unresolvedIncludeEntries || [])
            .some(entry => entry?.required !== false);
        const preprocessorTargetLineNumbers = hasUnresolvedRequiredIncludes ? null : lineNumbers;
        for (const diagnostic of collectPreprocessorAndLabelLiveDiagnostics(
            document,
            rootCtx,
            docLength,
            preprocessorTargetLineNumbers
        )) {
            if (shouldSkipDiagnosticLine(diagnostic)) continue;
            if (diagnostic.code === LIVE_UNRESOLVED_INCLUDE_DIAGNOSTIC_CODE) {
                hasUnresolvedRequiredIncludes = true;
            }
            pushDiagnostic(diagnostic);
        }
        const usageDiagnostics = hasUnresolvedRequiredIncludes || hasDelimiterDiagnostics || !warningsEnabledForScan
            ? EMPTY_DIAGNOSTICS
            : collectUsageLiveDiagnostics(document, rootCtx, docLength);
        if (scanStats) {
            scanStats.usageDiagnostics = usageDiagnostics.length;
        }
        for (const diagnostic of usageDiagnostics) {
            if (shouldSkipDiagnosticLine(diagnostic)) continue;
            const before = diagnostics.length;
            pushDiagnostic(diagnostic);
            if (scanStats && diagnostics.length > before) {
                scanStats.usageDiagnosticsKept++;
            }
        }
        if (!hasUnresolvedRequiredIncludes && !hasDelimiterDiagnostics && warningsEnabledForScan) {
            for (const diagnostic of collectDynamicUsageLiveDiagnostics(document, rootCtx, docLength, {
                inactiveStockLines: documentScanPlan.inactiveStockLines || null
            })) {
                if (shouldSkipDiagnosticLine(diagnostic)) continue;
                pushDiagnostic(diagnostic);
            }
        }
        for (const diagnostic of collectMultilinePawnStringLiteralDiagnostics(document, rootCtx, docLength, {
            lineCtrlChars: documentScanPlan.lineCtrlChars,
            packedStringDefaultLineFlags: (() => {
                if (!documentScanPlan.packedStringDefaultLineFlags) {
                    documentScanPlan.packedStringDefaultLineFlags = collectPackedStringDefaultLineFlags(
                        rootCtx.strippedLines || documentScanPlan.rawLines
                    );
                }
                return documentScanPlan.packedStringDefaultLineFlags;
            })(),
            targetLineNumbers: lineNumbers
        })) {
            if (shouldSkipDiagnosticLine(diagnostic)) continue;
            pushDiagnostic(diagnostic);
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
            if (shouldSkipInactiveLine(lineNumber)) continue;
            const invalidCodeCharacterState = invalidCodeCharacterCandidateLineFlags[lineNumber]
                ? collectInvalidCodeCharacterDiagnosticsForLineNumber(lineNumber)
                : null;
            const lineHasInvalidCodeCharacters = !!invalidCodeCharacterState?.diagnostics.length;
            const firstInvalidCodeCharacter = invalidCodeCharacterState?.firstCharacter ?? -1;
            if (shouldSkipTaintedLine(lineNumber)) continue;
            if (hasUnresolvedRequiredIncludes) continue;
            if (isBackslashContinuationLine(lineNumber)) continue;
            if (isEnumMemberLine(lineNumber)) continue;
            if (documentScanPlan.functionHeaderLines?.has(lineNumber)) continue;
            if (analysisLineFlags[lineNumber] && !isPreprocessorDirectiveLine(lineNumber)) {
                for (const diagnostic of collectCandidateDiagnosticsForLine(lineNumber)) {
                    if (
                        lineHasInvalidCodeCharacters &&
                        getDiagnosticStartLine(diagnostic) === lineNumber &&
                        isSingleLineDiagnostic(diagnostic) &&
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

        if (!hasUnresolvedRequiredIncludes && !isFullScan) {
            const touchedFunctions = new Set();
            for (const lineNumber of focusLineNumbers) {
                if (shouldSkipTaintedLine(lineNumber)) continue;
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
                    if (shouldSkipTaintedLine(func.startLine)) continue;
                    for (const diagnostic of collectHeaderDiagnosticsForFunction(func)) {
                        pushDiagnostic(diagnostic);
                    }
                }
            }
        } else if (!hasUnresolvedRequiredIncludes) {
            for (const func of headerCandidateFunctions) {
                if (documentScanPlan.inactiveStockLines?.has(func.startLine)) continue;
                if (shouldSkipTaintedLine(func.startLine)) continue;
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
                    getAnalysisCacheForLine,
                    inactivePreprocessorLineFlags,
                    isInactivePreprocessorLine
                }
            );
            if (isFullScan && structuralDiagnosticsCache) {
                structuralDiagnosticsCache.fullDiagnostics = result?.length ? result : EMPTY_DIAGNOSTICS;
            }
            return result;
        };
        if (!hasUnresolvedRequiredIncludes) {
            for (const diagnostic of collectStructuralDiagnosticsForScan()) {
                if (shouldSkipDiagnosticLine(diagnostic)) continue;
                pushDiagnostic(diagnostic);
            }
        }

        return diagnostics;
    }

    return {
        collectLiveValidationDiagnostics
    };
}

module.exports = { createLiveValidationScanner };
