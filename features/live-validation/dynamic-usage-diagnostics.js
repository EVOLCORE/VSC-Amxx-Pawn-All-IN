const { LIVE_DYNAMIC_USAGE_DIAGNOSTIC_CODE } = require('./diagnostic-codes');

function createDynamicUsageLiveDiagnostics(deps) {
    const {
        areWarningDiagnosticsEnabled,
        collectDynamicUsageIssues,
        createLiveValidationDiagnostic,
        createOffsetRange,
        getFunctionRangeMaps,
        getWarningSeverity,
        isIncludeDocument,
        isStrictIncludeValidationEnabled,
        t
    } = deps;

    const EMPTY_DIAGNOSTICS = [];
    const identifierCharRe = /[A-Za-z0-9_@]/;

    function getIssueMessage(issue) {
        const key = issue?.messageKey || '';
        return key ? t(key, issue.params || {}) : '';
    }

    function findIdentifierRange(lineText, name, occurrenceIndex = 0) {
        if (!name) return null;
        let seen = 0;
        let searchIndex = 0;
        while (searchIndex < lineText.length) {
            const start = lineText.indexOf(name, searchIndex);
            if (start < 0) return null;
            const before = start > 0 ? lineText[start - 1] : '';
            const after = lineText[start + name.length] || '';
            if (!identifierCharRe.test(before) && !identifierCharRe.test(after)) {
                if (seen === occurrenceIndex) {
                    return { start, end: start + name.length };
                }
                seen++;
            }
            searchIndex = start + Math.max(1, name.length);
        }
        return null;
    }

    function getDeclNameRange(document, rootCtx, decl, docLength, occurrenceState) {
        const lineNumber = decl?.lineNumber ?? -1;
        if (!Number.isInteger(lineNumber) || lineNumber < 0 || lineNumber >= document.lineCount) {
            return null;
        }
        const lineStartOffsets = rootCtx?.lineStartOffsets || null;
        const lineStartOffset = lineStartOffsets?.[lineNumber] ?? document.offsetAt({ line: lineNumber, character: 0 });
        const lineText = String(rootCtx?.rawLines?.[lineNumber] ?? document.lineAt(lineNumber).text ?? '');
        const name = String(decl?.name || '').trim();
        if (!name) return null;

        const occurrenceKey = `${lineNumber}\u0000${name}`;
        const occurrenceIndex = occurrenceState.get(occurrenceKey) || 0;
        occurrenceState.set(occurrenceKey, occurrenceIndex + 1);

        const range = findIdentifierRange(lineText, name, occurrenceIndex) ||
            findIdentifierRange(lineText, name, 0);
        if (!range) return null;
        return createOffsetRange(
            document,
            lineStartOffset + range.start,
            lineStartOffset + range.end,
            docLength
        );
    }

    function getCachedDynamicUsageIssues(rootCtx) {
        const semanticSession = rootCtx?.semanticSession || null;
        const parsedDecls = rootCtx?.parsedDecls || null;
        if (!parsedDecls || typeof collectDynamicUsageIssues !== 'function') {
            return EMPTY_DIAGNOSTICS;
        }
        let byParsedDecls = semanticSession?.dynamicUsageIssuesByParsedDecls || null;
        if (byParsedDecls?.has(parsedDecls)) {
            return byParsedDecls.get(parsedDecls) || EMPTY_DIAGNOSTICS;
        }
        const issues = collectDynamicUsageIssues(rootCtx, {
            functionRangeMaps: getFunctionRangeMaps?.(rootCtx)
        }) || EMPTY_DIAGNOSTICS;
        if (semanticSession) {
            if (!byParsedDecls) {
                byParsedDecls = new WeakMap();
                semanticSession.dynamicUsageIssuesByParsedDecls = byParsedDecls;
            }
            byParsedDecls.set(parsedDecls, issues);
        }
        return issues;
    }

    function collectDynamicUsageLiveDiagnostics(document, rootCtx, docLength, options = {}) {
        if (!areWarningDiagnosticsEnabled?.()) return EMPTY_DIAGNOSTICS;
        if (isIncludeDocument?.(document) && !isStrictIncludeValidationEnabled?.()) {
            return EMPTY_DIAGNOSTICS;
        }
        const inactiveLines = options.inactiveStockLines || null;
        const issues = getCachedDynamicUsageIssues(rootCtx);
        if (!issues.length) return EMPTY_DIAGNOSTICS;

        const diagnostics = [];
        const occurrenceState = new Map();
        for (const { decl, functionDecl, issue } of issues) {
            if (
                inactiveLines?.has?.(decl?.lineNumber ?? -1) ||
                inactiveLines?.has?.(functionDecl?.startLine ?? functionDecl?.lineNumber ?? -1)
            ) {
                continue;
            }
            const range = getDeclNameRange(document, rootCtx, decl, docLength, occurrenceState);
            if (!range) continue;
            const message = getIssueMessage(issue);
            if (!message) continue;
            const diagnostic = createLiveValidationDiagnostic(
                range,
                message,
                getWarningSeverity()
            );
            diagnostic.code = LIVE_DYNAMIC_USAGE_DIAGNOSTIC_CODE;
            diagnostics.push(diagnostic);
        }
        return diagnostics;
    }

    return {
        collectDynamicUsageLiveDiagnostics
    };
}

module.exports = { createDynamicUsageLiveDiagnostics };
