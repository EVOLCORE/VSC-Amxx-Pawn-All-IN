const { countTextLines, splitPawnLines } = require('../syntax/lines');

const SEMANTIC_EQUIVALENT_NARROW_LINE_THRESHOLD = 128;
const BODY_ONLY_LOCAL_MAX_BASE_LINES = 12;
const editedFunctionBodyRangesByBase = new WeakMap();

function getEditedFunctionBodyRangeIndex(base) {
    if (!base || (typeof base !== 'object' && typeof base !== 'function')) {
        return { byLine: [] };
    }
    const cached = editedFunctionBodyRangesByBase.get(base);
    if (cached) return cached;

    const functions = base?.functions || [];
    const depths = base?.depths || [];
    const byLine = [];
    const rememberRange = range => {
        for (let line = range.startLine; line <= range.endLine; line++) {
            const existing = byLine[line] || null;
            if (
                !existing ||
                range.startLine > existing.startLine ||
                (range.startLine === existing.startLine && range.endLine < existing.endLine)
            ) {
                byLine[line] = range;
            }
        }
    };
    for (const func of functions) {
        const headerEndLine = func.headerEndLine ?? func.startLine ?? 0;
        const headerDepth = depths[headerEndLine] ?? 0;
        let bodyStartLine = -1;
        let bodyDepth = 0;
        for (let line = headerEndLine + 1; line < depths.length; line++) {
            const lineDepth = depths[line] ?? 0;
            if (lineDepth > headerDepth) {
                bodyStartLine = line;
                bodyDepth = lineDepth;
                break;
            }
        }
        if (bodyStartLine < 0) continue;
        let bodyEndLine = bodyStartLine;
        for (let line = bodyStartLine + 1; line < depths.length; line++) {
            if ((depths[line] ?? 0) < bodyDepth) {
                bodyEndLine = line - 1;
                break;
            }
            bodyEndLine = line;
        }
        rememberRange({
            startLine: bodyStartLine,
            endLine: bodyEndLine
        });
    }

    const index = { byLine };
    editedFunctionBodyRangesByBase.set(base, index);
    return index;
}

function findEditedFunctionBodyRange(base, lineNumber) {
    if (!Number.isInteger(lineNumber) || lineNumber < 0) return null;
    return getEditedFunctionBodyRangeIndex(base).byLine[lineNumber] || null;
}

function expandChangedRangesToLines(document, contentChanges = []) {
    const lines = new Set();
    const lineCount = Number.isInteger(document?.lineCount) ? document.lineCount : 0;
    for (const change of contentChanges || []) {
        const start = Math.max(0, change?.range?.start?.line ?? 0);
        const end = Math.max(start, change?.range?.end?.line ?? start);
        const startLine = Math.max(0, start - 1);
        const endLine = lineCount > 0
            ? Math.min(lineCount - 1, end + 1)
            : end + 1;
        for (let line = startLine; line <= endLine; line++) {
            lines.add(line);
        }
    }
    return [...lines].sort((left, right) => left - right);
}

function shouldEscalateEditedValidation(document, contentChanges = [], baseLines = [], editImpact = null) {
    if (typeof editImpact?.escalate === 'boolean') {
        return editImpact.escalate;
    }
    if (!document || !Array.isArray(contentChanges) || !contentChanges.length) {
        return false;
    }

    if (contentChanges.length >= 8) {
        return true;
    }

    const affectedLineCount = Array.isArray(baseLines) ? baseLines.length : 0;
    const lineCount = Number.isInteger(document.lineCount) ? document.lineCount : 0;
    const largeAffectedLineThreshold = Math.max(60, Math.floor(lineCount * 0.18));
    if (affectedLineCount >= largeAffectedLineThreshold) {
        return true;
    }

    for (const change of contentChanges) {
        const startLine = change?.range?.start?.line ?? 0;
        const endLine = change?.range?.end?.line ?? startLine;
        const replacedLineSpan = Math.max(1, endLine - startLine + 1);
        const insertedLineSpan = countTextLines(change?.text || '');
        if (replacedLineSpan !== insertedLineSpan) {
            return true;
        }
        if (Math.max(replacedLineSpan, insertedLineSpan) >= 24) {
            return true;
        }
    }

    return false;
}

function resolveEditedValidationPlan(document, contentChanges = [], editImpact = null) {
    const affectedLines = Array.isArray(editImpact?.affectedLines)
        ? editImpact.affectedLines
        : expandChangedRangesToLines(document, contentChanges);
    const escalate = editImpact?.kind !== 'incremental' ||
        shouldEscalateEditedValidation(document, contentChanges, affectedLines, editImpact);
    if (escalate) {
        return {
            mode: 'full',
            full: true,
            lines: [],
            affectedLines,
            reason: 'textChangedEditedEscalated',
            editImpact
        };
    }
    return {
        mode: 'edited',
        full: false,
        lines: affectedLines,
        affectedLines,
        reason: 'textChangedEdited',
        editImpact
    };
}

function canUseLocalBodyEditedValidation(rootCtx, baseLineNumbers, editImpact) {
    if (!rootCtx || !Array.isArray(baseLineNumbers) || !baseLineNumbers.length) return false;
    if (baseLineNumbers.length > BODY_ONLY_LOCAL_MAX_BASE_LINES) return false;
    const lineIndex = rootCtx.lineIndex;
    const rawLines = rootCtx.rawLines || [];
    const changedLines = new Set();
    for (const range of editImpact?.ranges || []) {
        const startLine = Math.max(0, range?.startLine ?? 0);
        const endLine = Math.max(startLine, range?.endLine ?? startLine);
        const replacedLineSpan = Math.max(1, endLine - startLine + 1);
        const insertedLineSpan = countTextLines(range?.changeText || '');
        if (replacedLineSpan !== insertedLineSpan) return false;
        for (let line = startLine; line <= endLine; line++) {
            changedLines.add(line);
        }
    }
    if (!changedLines.size) return false;
    const hasUnbalancedDelimiter = (source, openChar, closeChar) => {
        let balance = 0;
        for (const char of source) {
            if (char === openChar) balance++;
            else if (char === closeChar) balance--;
        }
        return balance !== 0;
    };
    const canChangeFunctionSummaryDiagnostics = source =>
        /\b(?:return|goto|break|continue)\b/.test(String(source || ''));
    for (const line of changedLines) {
        if (!Number.isInteger(line) || line < 0 || line >= rawLines.length) return false;
        if (lineIndex.isPotentialBodyContextChangeLine(line)) return false;
        const source = String(rawLines[line] || '');
        const trimmed = source.trim();
        if (canChangeFunctionSummaryDiagnostics(source)) return false;
        if (/[#{}]|\/\*|\*\//.test(source)) return false;
        if (/^(?:case\b|default\b)/.test(trimmed)) return false;
        if (
            hasUnbalancedDelimiter(source, '(', ')') ||
            hasUnbalancedDelimiter(source, '[', ']')
        ) {
            return false;
        }
        if (/\\\s*$/.test(source.trimEnd())) return false;
    }
    for (const range of editImpact?.ranges || []) {
        if (canChangeFunctionSummaryDiagnostics(range?.changeText || '')) return false;
    }
    return true;
}

function createEditImpactResolver(deps) {
    const {
        normalizeFsPath,
        fileDeclParseCache,
        parsePreprocessorDirectiveLine,
        isExplicitDeclarationStartLine
    } = deps;

    const structuralMarkerRe = /#|\{|\}|\/\*|\*\//;
    const trailingWhitespaceRe = /[ \t]+$/;

    const withDecision = (document, contentChanges, impact) => {
        const affectedLines = expandChangedRangesToLines(document, contentChanges);
        return {
            ...impact,
            affectedLines,
            escalate: impact.kind !== 'incremental' ||
                shouldEscalateEditedValidation(document, contentChanges, affectedLines)
        };
    };

    function resolveDocumentEditImpact(document, contentChanges = []) {
        if (!document?.fileName || !Array.isArray(contentChanges) || !contentChanges.length) {
            return withDecision(document, contentChanges, { kind: 'unknown' });
        }
        const normalized = normalizeFsPath(document.fileName);
        const fileCache = normalized ? fileDeclParseCache.get(normalized) : null;
        const previousBase = fileCache?.base || null;
        if (!previousBase) {
            return withDecision(document, contentChanges, { kind: 'structural' });
        }
        if (contentChanges.length >= 8) {
            return withDecision(document, contentChanges, { kind: 'structural' });
        }

        let nextDocumentLines = null;
        const getNextDocumentLines = () => {
            if (nextDocumentLines) return nextDocumentLines;
            if (typeof document.getText === 'function') {
                nextDocumentLines = splitPawnLines(document.getText() || '');
                return nextDocumentLines;
            }
            nextDocumentLines = [];
            const lineCount = Number.isInteger(document.lineCount) ? document.lineCount : 0;
            for (let lineNumber = 0; lineNumber < lineCount; lineNumber++) {
                nextDocumentLines.push(String(document.lineAt?.(lineNumber)?.text || ''));
            }
            return nextDocumentLines;
        };
        const isSafeWhitespaceOnlyLineChange = (previousLine, nextLine) => {
            const previousText = String(previousLine || '');
            const nextText = String(nextLine || '');
            if (previousText === nextText) return true;
            if (parsePreprocessorDirectiveLine(previousText) || parsePreprocessorDirectiveLine(nextText)) {
                return false;
            }
            return previousText.replace(trailingWhitespaceRe, '') === nextText.replace(trailingWhitespaceRe, '');
        };
        const ranges = [];
        let allChangesAreSafeWhitespaceOnly = true;
        let allChangesStayInsideFunctionBody = true;
        for (const change of contentChanges) {
            const startLine = Math.max(0, change?.range?.start?.line ?? 0);
            const endLine = Math.max(startLine, change?.range?.end?.line ?? startLine);
            const replacedLineSpan = Math.max(1, endLine - startLine + 1);
            const insertedLineSpan = countTextLines(change?.text || '');
            if (Math.max(replacedLineSpan, insertedLineSpan) >= 24) {
                return withDecision(document, contentChanges, { kind: 'structural' });
            }
            const functionBodyRange = findEditedFunctionBodyRange(previousBase, startLine);
            const isInsideFunctionBody = !!(functionBodyRange && endLine <= functionBodyRange.endLine);
            if (!isInsideFunctionBody) {
                allChangesStayInsideFunctionBody = false;
            }
            if (replacedLineSpan !== insertedLineSpan) {
                allChangesAreSafeWhitespaceOnly = false;
            } else {
                const nextLines = getNextDocumentLines();
                for (let offset = 0; offset < replacedLineSpan; offset++) {
                    const lineNumber = startLine + offset;
                    const previousLine = previousBase.rawLines[lineNumber] || '';
                    const nextLine = nextLines[lineNumber] || '';
                    if (!isSafeWhitespaceOnlyLineChange(previousLine, nextLine)) {
                        allChangesAreSafeWhitespaceOnly = false;
                        break;
                    }
                }
            }
            ranges.push({
                startLine,
                endLine,
                changeText: String(change?.text || '')
            });
        }

        if (allChangesAreSafeWhitespaceOnly) {
            return withDecision(document, contentChanges, {
                kind: 'incremental',
                ranges,
                bodyOnly: allChangesStayInsideFunctionBody,
                semanticEquivalent: true
            });
        }

        const nextLines = getNextDocumentLines();
        for (const { startLine, endLine, changeText } of ranges) {
            const changedLineCount = countTextLines(changeText || '');
            const lastLine = Math.max(endLine, startLine + changedLineCount - 1);
            for (let lineNumber = startLine; lineNumber <= lastLine; lineNumber++) {
                const previousLine = previousBase.rawLines[lineNumber] || '';
                const nextLine = nextLines[lineNumber] || '';
                if (isExplicitDeclarationStartLine(previousLine) || isExplicitDeclarationStartLine(nextLine)) {
                    return withDecision(document, contentChanges, { kind: 'structural' });
                }
            }
        }

        for (const { startLine, endLine, changeText } of ranges) {
            const functionBodyRange = findEditedFunctionBodyRange(previousBase, startLine);
            if (!functionBodyRange || endLine > functionBodyRange.endLine) {
                return withDecision(document, contentChanges, { kind: 'structural' });
            }

            const previousWindowStart = Math.max(functionBodyRange.startLine, startLine - 1);
            const previousWindowEnd = Math.min(functionBodyRange.endLine, endLine + 1);
            const previousText = previousBase.rawLines.slice(previousWindowStart, previousWindowEnd + 1).join('\n');
            if (structuralMarkerRe.test(previousText) || structuralMarkerRe.test(changeText)) {
                return withDecision(document, contentChanges, { kind: 'structural' });
            }
        }

        return withDecision(document, contentChanges, {
            kind: 'incremental',
            ranges,
            bodyOnly: true,
            semanticEquivalent: false
        });
    }

    return {
        resolveDocumentEditImpact,
        summarizeDocumentEditImpact: resolveDocumentEditImpact
    };
}

module.exports = {
    SEMANTIC_EQUIVALENT_NARROW_LINE_THRESHOLD,
    BODY_ONLY_LOCAL_MAX_BASE_LINES,
    findEditedFunctionBodyRange,
    expandChangedRangesToLines,
    shouldEscalateEditedValidation,
    resolveEditedValidationPlan,
    canUseLocalBodyEditedValidation,
    createEditImpactResolver
};
