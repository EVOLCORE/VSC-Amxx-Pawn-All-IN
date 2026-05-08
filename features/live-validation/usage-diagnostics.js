const { LIVE_USAGE_DIAGNOSTIC_CODE } = require('./diagnostic-codes');

function createUsageDiagnostics(deps) {
    const {
        areWarningDiagnosticsEnabled,
        collectSymbolUsageIssues,
        createLiveValidationDiagnostic,
        createOffsetRange,
        getFunctionRangeMaps,
        getWarningSeverity,
        isIncludeDocument,
        isStrictIncludeValidationEnabled,
        t
    } = deps;

    const EMPTY_DIAGNOSTICS = [];

    function getIssueMessage(issue) {
        const key = issue?.messageKey || '';
        return key ? t(key, issue.params || {}) : '';
    }

    function getEntryNameRange(document, rootCtx, entry, docLength) {
        const decl = entry?.decl || null;
        const lineNumber = decl?.lineNumber ?? -1;
        if (!Number.isInteger(lineNumber) || lineNumber < 0 || lineNumber >= document.lineCount) {
            return null;
        }
        const lineStartOffsets = rootCtx?.lineStartOffsets || null;
        const lineStartOffset = lineStartOffsets?.[lineNumber] ?? document.offsetAt({ line: lineNumber, character: 0 });
        const lineText = String(rootCtx?.rawLines?.[lineNumber] ?? document.lineAt(lineNumber).text ?? '');
        const name = String(entry?.name || decl?.name || '').trim();
        let start = Number.isInteger(entry?.nameStart) ? entry.nameStart : -1;
        let end = Number.isInteger(entry?.nameEnd) ? entry.nameEnd : -1;
        if (start < 0 || end <= start || lineText.slice(start, end) !== name) {
            start = name ? lineText.indexOf(name) : -1;
            end = start >= 0 ? start + name.length : -1;
        }
        if (start < 0 || end <= start) return null;
        if (name.length <= 1) {
            let declarationStart = start;
            for (let index = start - 1; index >= 0; index--) {
                const char = lineText[index] || '';
                if (char === ',' || char === ';' || char === '(' || char === '{' || char === '}') break;
                declarationStart = index;
            }
            while (declarationStart < start && /\s/.test(lineText[declarationStart])) declarationStart++;
            if (declarationStart < start) start = declarationStart;
        }
        return createOffsetRange(
            document,
            lineStartOffset + start,
            lineStartOffset + end,
            docLength
        );
    }

    function getCachedUsageIssues(rootCtx) {
        const semanticSession = rootCtx?.semanticSession || null;
        const parsedDecls = rootCtx?.parsedDecls || null;
        if (!parsedDecls || typeof collectSymbolUsageIssues !== 'function') {
            return EMPTY_DIAGNOSTICS;
        }
        let byParsedDecls = semanticSession?.symbolUsageIssuesByParsedDecls || null;
        if (byParsedDecls?.has(parsedDecls)) {
            return byParsedDecls.get(parsedDecls) || EMPTY_DIAGNOSTICS;
        }
        const issues = collectSymbolUsageIssues(rootCtx, {
            functionRangeMaps: getFunctionRangeMaps?.(rootCtx)
        }) || EMPTY_DIAGNOSTICS;
        if (semanticSession) {
            if (!byParsedDecls) {
                byParsedDecls = new WeakMap();
                semanticSession.symbolUsageIssuesByParsedDecls = byParsedDecls;
            }
            byParsedDecls.set(parsedDecls, issues);
        }
        return issues;
    }

    function collectUsageLiveDiagnostics(document, rootCtx, docLength) {
        if (!areWarningDiagnosticsEnabled?.()) return EMPTY_DIAGNOSTICS;
        if (isIncludeDocument?.(document) && !isStrictIncludeValidationEnabled?.()) {
            return EMPTY_DIAGNOSTICS;
        }
        const issues = getCachedUsageIssues(rootCtx);
        if (!issues.length) return EMPTY_DIAGNOSTICS;

        const diagnostics = [];
        for (const { entry, issue } of issues) {
            const range = getEntryNameRange(document, rootCtx, entry, docLength);
            if (!range) continue;
            const message = getIssueMessage(issue);
            if (!message) continue;
            const diagnostic = createLiveValidationDiagnostic(
                range,
                message,
                getWarningSeverity()
            );
            diagnostic.code = LIVE_USAGE_DIAGNOSTIC_CODE;
            diagnostics.push(diagnostic);
        }
        return diagnostics;
    }

    return {
        collectUsageLiveDiagnostics
    };
}

module.exports = { createUsageDiagnostics };
