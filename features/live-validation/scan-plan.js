const { isBodyDeclarationContextChangeLine } = require('../../core/syntax/line-index');
const {
    resolveLineStartOffset,
    splitPawnLines
} = require('../../core/syntax/lines');
const {
    createLineNumberFlags,
    mergeSortedUniqueLineNumbers
} = require('../../core/syntax/line-number-lists');
const { buildInactivePreprocessorLineFlags } = require('../../core/syntax/preprocessor-lines');
const { createLineMembership } = require('../../core/utils/line-membership');

const EMPTY_INLINE_CALLS = [];

function createFilledLineMap(lineCount, value) {
    const map = new Int32Array(Math.max(0, lineCount) + 1);
    map.fill(value);
    return map;
}

function createDocumentScanPlanBuilder(deps = {}) {
    const {
        getCtrlCharStateForContent,
        settingsService,
        collectInlineNamedCallContexts,
        getFunctionRangeMaps,
        getFunctionHeaderLines,
        getEnumMemberDeclarationLines
    } = deps;

    const documentScanPlanCache = new WeakMap();

    function getDocumentScanPlan(rootCtx, document) {
        const parsedDecls = rootCtx?.parsedDecls || null;
        const unusedStockValidationMode = settingsService?.getUnusedStockValidationMode?.() || 'reachable-only';
        const rawLines = rootCtx.rawLines || splitPawnLines(rootCtx.text);
        const lineIndex = rootCtx.lineIndex;
        const inactivePreprocessorLineFlags = buildInactivePreprocessorLineFlags(
            rawLines,
            rootCtx.preprocessedState?.rawLines,
            document.lineCount,
            {
                isPreprocessorDirectiveLineNumber: line =>
                    typeof lineIndex?.isPreprocessorDirectiveLine === 'function' &&
                    lineIndex.isPreprocessorDirectiveLine(line)
            }
        );
        const lineCtrlChars = rootCtx.lineCtrlChars ||
            rootCtx.resolver.lineCtrlChars ||
            getCtrlCharStateForContent(rootCtx.text, document.fileName).lineCtrlChars;
        const getPlanForStockMode = structuralPlan => {
            let inactiveStockLines = structuralPlan.inactiveStockLinesByMode.get(unusedStockValidationMode);
            if (!inactiveStockLines) {
                inactiveStockLines = buildInactiveStockLines(structuralPlan, unusedStockValidationMode);
                structuralPlan.inactiveStockLinesByMode.set(unusedStockValidationMode, inactiveStockLines);
            }

            let plan = structuralPlan.planByStockMode.get(unusedStockValidationMode);
            if (!plan) {
                plan = {
                    rawLines: structuralPlan.rawLines,
                    lineCtrlChars: structuralPlan.lineCtrlChars,
                    lineIndex: structuralPlan.lineIndex,
                    nextTopLevelContextChangeLine: structuralPlan.nextTopLevelContextChangeLine,
                    nextBodyContextChangeLine: structuralPlan.nextBodyContextChangeLine,
                    nextBodyDeclarationContextChangeLine: structuralPlan.nextBodyDeclarationContextChangeLine,
                    nextExplicitContextBoundaryLine: structuralPlan.nextExplicitContextBoundaryLine,
                    backslashContinuationLines: structuralPlan.backslashContinuationLines,
                    functionHeaderLines: structuralPlan.functionHeaderLines,
                    functionBodyRangeByLine: structuralPlan.functionBodyRangeByLine,
                    inactiveStockLines,
                    inactivePreprocessorLineFlags: structuralPlan.inactivePreprocessorLineFlags,
                    enumMemberLines: structuralPlan.enumMemberLines,
                    generalDiagnosticCandidateFlags: structuralPlan.generalDiagnosticCandidateFlags,
                    generalDiagnosticCandidateLines: structuralPlan.generalDiagnosticCandidateLines,
                    indexedExpressionsByLine: structuralPlan.indexedExpressionsByLine,
                    inlineCallsByLine: structuralPlan.inlineCallsByLine,
                    fullDiagnosticLinePlan: null
                };
                Object.defineProperty(plan, 'lineStringStartQuoteCodes', {
                    enumerable: true,
                    configurable: true,
                    get() {
                        return structuralPlan.lineStringStartQuoteCodes;
                    },
                    set(value) {
                        structuralPlan.lineStringStartQuoteCodes = value;
                    }
                });
                structuralPlan.planByStockMode.set(unusedStockValidationMode, plan);
            }
            return plan;
        };
        if (parsedDecls && documentScanPlanCache.has(parsedDecls)) {
            const cachedEntry = documentScanPlanCache.get(parsedDecls);
            if (
                cachedEntry.rawLines === rawLines &&
                cachedEntry.lineCtrlChars === lineCtrlChars &&
                cachedEntry.lineIndex === lineIndex
            ) {
                return getPlanForStockMode(cachedEntry.structuralPlan);
            }
        }

        const isIndexedBraceOnlyLine = line => lineIndex.isBraceOnlyLine(line);
        const nextTopLevelContextChangeLine = createFilledLineMap(document.lineCount, document.lineCount);
        const nextBodyContextChangeLine = createFilledLineMap(document.lineCount, document.lineCount);
        const nextBodyDeclarationContextChangeLine = createFilledLineMap(document.lineCount, document.lineCount);
        const nextExplicitContextBoundaryLine = createFilledLineMap(document.lineCount, document.lineCount);
        const backslashContinuationLines = lineIndex.backslashContinuationLines || new Uint8Array(document.lineCount);
        let nextTopLevelChange = document.lineCount;
        let nextBodyChange = document.lineCount;
        let nextBodyDeclarationChange = document.lineCount;
        let nextExplicitBoundary = document.lineCount;
        const functionHeaderLines = getFunctionHeaderLines(rootCtx);
        const bodyDeclarationContextChangeFlags = (() => {
            const baseFlags = rootCtx.bodyDeclarationContextChangeFlags || null;
            const flags = baseFlags
                ? new Uint8Array(baseFlags)
                : new Uint8Array(document.lineCount);
            if (!baseFlags) {
                const strippedLines = rootCtx.strippedLines || rawLines;
                for (const line of lineIndex.bodyDeclarationCandidateLines || []) {
                    if (line < 0 || line >= document.lineCount) continue;
                    if (isBodyDeclarationContextChangeLine(strippedLines[line] || rawLines[line] || '')) {
                        flags[line] = 1;
                    }
                }
            }
            for (const local of rootCtx.parsedDecls?.locals || []) {
                if (!local?.macroForVar) continue;
                const line = local.lineNumber;
                if (line < 0 || line >= document.lineCount) continue;
                flags[line] = 1;
            }
            return flags;
        })();
        for (let line = document.lineCount - 1; line >= 0; line--) {
            if (lineIndex.isPotentialTopLevelContextChangeLine(line)) {
                nextTopLevelChange = line;
            }
            if (lineIndex.isPotentialBodyContextChangeLine(line)) {
                nextBodyChange = line;
            }
            if (bodyDeclarationContextChangeFlags[line]) {
                nextBodyDeclarationChange = line;
            }
            const isBraceOnlyLine = isIndexedBraceOnlyLine(line);
            if (functionHeaderLines.has(line) || isBraceOnlyLine) {
                nextExplicitBoundary = line;
            }
            nextTopLevelContextChangeLine[line] = nextTopLevelChange;
            nextBodyContextChangeLine[line] = nextBodyChange;
            nextBodyDeclarationContextChangeLine[line] = nextBodyDeclarationChange;
            nextExplicitContextBoundaryLine[line] = nextExplicitBoundary;
        }

        const functionRanges = getFunctionRangeMaps(rootCtx);
        const functionBodyRangeByLine = functionRanges.byLine;
        const functionBodyRangeByFunction = functionRanges.byFunction;
        const functionByName = new Map();
        const inlineCallsByLine = rootCtx.semanticSession?.inlineCallsByLine || [];
        const enumMemberLines = getEnumMemberDeclarationLines(rootCtx);
        for (const func of rootCtx.parsedDecls.functions) {
            if (!functionByName.has(func.name)) {
                functionByName.set(func.name, []);
            }
            functionByName.get(func.name).push(func);
        }

        function buildInactiveStockLines(structuralPlan, stockMode) {
            const inactiveStockLines = createLineMembership(document.lineCount);
            const stockFunctions = (rootCtx.parsedDecls.functions || []).filter(func => func?.type === 'stock');
            if (!stockFunctions.length || stockMode === 'all') {
                return inactiveStockLines;
            }

            const forEachBodyLine = (func, callback) => {
                const bodyRange = structuralPlan.functionBodyRangeByFunction.get(func) || null;
                if (!bodyRange) return;
                const startLine = Math.max(0, bodyRange.startLine);
                const endLine = Math.min(document.lineCount - 1, bodyRange.endLine);
                for (let line = startLine; line <= endLine; line++) {
                    callback(line);
                }
            };
            const markInactiveFunction = func => {
                const headerStartLine = func.startLine ?? func.lineNumber ?? -1;
                const headerEndLine = func.headerEndLine ?? headerStartLine;
                for (let line = headerStartLine; line <= headerEndLine; line++) {
                    if (line >= 0) inactiveStockLines.add(line);
                }
                forEachBodyLine(func, bodyLine => inactiveStockLines.add(bodyLine));
            };

            if (stockMode === 'skip') {
                for (const func of stockFunctions) {
                    markInactiveFunction(func);
                }
                return inactiveStockLines;
            }

            if (stockMode !== 'reachable-only') {
                return inactiveStockLines;
            }

            const functions = rootCtx.parsedDecls.functions || [];
            const functionIndexByDecl = new Map();
            const stockFunctionFlags = new Uint8Array(functions.length);
            for (let index = 0; index < functions.length; index++) {
                const func = functions[index];
                functionIndexByDecl.set(func, index);
                if (func?.type === 'stock') {
                    stockFunctionFlags[index] = 1;
                }
            }

            const reachableFunctionFlags = new Uint8Array(functions.length);
            const pendingFunctions = [];
            for (let index = 0; index < functions.length; index++) {
                if (stockFunctionFlags[index]) continue;
                reachableFunctionFlags[index] = 1;
                pendingFunctions.push(functions[index]);
            }
            const getLineStartOffset = lineNumber => resolveLineStartOffset(rootCtx.lineStartOffsets, lineNumber, 0);
            const collectReachabilityCallsForLine = lineNumber => {
                const cachedInlineCalls = structuralPlan.inlineCallsByLine[lineNumber];
                if (cachedInlineCalls !== undefined) return cachedInlineCalls;
                const lineText = String(rootCtx.strippedLines?.[lineNumber] || structuralPlan.rawLines[lineNumber] || '');
                if (lineText.indexOf('(') < 0) {
                    structuralPlan.inlineCallsByLine[lineNumber] = EMPTY_INLINE_CALLS;
                    return EMPTY_INLINE_CALLS;
                }
                const escapeChar = rootCtx.resolver?.ctrlCharAtLine?.(lineNumber) || '';
                const inlineCalls = collectInlineNamedCallContexts(lineText, getLineStartOffset(lineNumber), escapeChar, {
                    includeClosedCalls: true
                });
                structuralPlan.inlineCallsByLine[lineNumber] = inlineCalls?.length ? inlineCalls : EMPTY_INLINE_CALLS;
                return structuralPlan.inlineCallsByLine[lineNumber];
            };

            while (pendingFunctions.length) {
                const func = pendingFunctions.pop();
                forEachBodyLine(func, lineNumber => {
                    const inlineCalls = collectReachabilityCallsForLine(lineNumber);
                    for (const callCtx of inlineCalls) {
                        const callName = callCtx?.funcName || '';
                        if (!callName) continue;
                        const calledFunctions = structuralPlan.functionByName.get(callName) || [];
                        for (const calledFunc of calledFunctions) {
                            const calledIndex = functionIndexByDecl.get(calledFunc);
                            if (!Number.isInteger(calledIndex) || !stockFunctionFlags[calledIndex]) continue;
                            if (reachableFunctionFlags[calledIndex]) continue;
                            reachableFunctionFlags[calledIndex] = 1;
                            pendingFunctions.push(calledFunc);
                        }
                    }
                });
            }

            for (let index = 0; index < functions.length; index++) {
                if (!stockFunctionFlags[index] || reachableFunctionFlags[index]) continue;
                markInactiveFunction(functions[index]);
            }

            return inactiveStockLines;
        }

        const generalDiagnosticCandidateFlags = new Uint8Array(document.lineCount);
        const generalDiagnosticCandidateLines = [];
        for (const line of lineIndex.generalDiagnosticCandidateLines || []) {
            if (line < 0 || line >= document.lineCount) continue;
            if (
                !lineIndex.unknownSymbolCandidateLineFlags?.[line] &&
                !lineIndex.declarationDiagnosticCandidateLineFlags?.[line] &&
                !lineIndex.expressionOperatorCandidateLineFlags?.[line] &&
                !lineIndex.strayTokenCandidateLineFlags?.[line] &&
                !lineIndex.invalidCodeCharacterCandidateLineFlags?.[line]
            ) {
                continue;
            }
            generalDiagnosticCandidateFlags[line] = 1;
            generalDiagnosticCandidateLines.push(line);
        }
        const structuralPlan = {
            rawLines,
            lineCtrlChars,
            lineIndex,
            inactivePreprocessorLineFlags,
            nextTopLevelContextChangeLine,
            nextBodyContextChangeLine,
            nextBodyDeclarationContextChangeLine,
            nextExplicitContextBoundaryLine,
            backslashContinuationLines,
            functionHeaderLines,
            functionBodyRangeByLine,
            functionBodyRangeByFunction,
            functionByName,
            enumMemberLines,
            lineStringStartQuoteCodes: null,
            generalDiagnosticCandidateFlags,
            generalDiagnosticCandidateLines,
            indexedExpressionsByLine: rootCtx.semanticSession?.strippedIndexedExpressionsByLine || [],
            inlineCallsByLine,
            inactiveStockLinesByMode: new Map(),
            planByStockMode: new Map()
        };
        if (parsedDecls) {
            documentScanPlanCache.set(parsedDecls, {
                rawLines,
                lineCtrlChars,
                lineIndex,
                structuralPlan
            });
        }
        return getPlanForStockMode(structuralPlan);
    }

    return { getDocumentScanPlan };
}

function buildDiagnosticLinePlan(lineCount, analysisLineNumbers, generalLineNumbers) {
    const analysisLineFlags = createLineNumberFlags(lineCount, analysisLineNumbers);
    const generalLineFlags = createLineNumberFlags(lineCount, generalLineNumbers);
    const combinedDiagnosticLineNumbers = mergeSortedUniqueLineNumbers(
        lineCount,
        analysisLineNumbers,
        generalLineNumbers
    );
    return {
        analysisLineFlags,
        generalLineFlags,
        combinedDiagnosticLineNumbers
    };
}

module.exports = {
    createDocumentScanPlanBuilder,
    buildDiagnosticLinePlan
};
