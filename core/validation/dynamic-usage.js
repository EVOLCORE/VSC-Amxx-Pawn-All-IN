const { parsePragmaDirectiveLine } = require('../syntax/pragma-directives');
const { hasDeclModifier } = require('../declarations/modifiers');

function createDynamicUsageDiagnostics(deps = {}) {
    const {
        evaluatePawnNumericExpr,
        getEffectiveDeclDimParts,
        parseDimSpec
    } = deps;

    const DEFAULT_DYNAMIC_CELLS = 4096;
    const EMPTY_ISSUES = [];

    function getPragmaDynamicLimit(rootCtx, analysisCache = null) {
        const lines = rootCtx?.preprocessedState?.rawLines ||
            rootCtx?.strippedLines ||
            rootCtx?.rawLines ||
            [];
        let limit = DEFAULT_DYNAMIC_CELLS;
        let decls = null;
        const getDecls = () => {
            if (analysisCache) return [];
            if (!decls) decls = rootCtx?.allDecls || [];
            return decls;
        };

        for (const line of lines) {
            const pragma = parsePragmaDirectiveLine(line);
            if (pragma?.name !== 'dynamic') continue;
            const expr = String(pragma.value || '').trim();
            if (!expr) continue;
            const value = evaluatePawnNumericExpr(expr, getDecls(), new Set(), analysisCache);
            if (Number.isFinite(value) && value >= 0) {
                limit = Math.floor(value);
            }
        }

        return limit;
    }

    function getDeclCellSize(decl, rootCtx, analysisCache = null) {
        if (!decl || decl.type !== 'variable') return null;
        if (decl.isArg) return null;
        if (hasDeclModifier(decl, 'static')) return null;
        const dimParts = getEffectiveDeclDimParts(decl);
        if (!dimParts.length) return 1;

        let decls = null;
        const getDecls = () => {
            if (analysisCache) return [];
            if (!decls) decls = rootCtx?.allDecls || [];
            return decls;
        };
        let cells = 1;
        for (const part of dimParts) {
            const spec = analysisCache?.getDimSpec?.(part) ||
                parseDimSpec(part, getDecls(), new Set(), analysisCache);
            const capacity = spec?.capacity;
            if (!Number.isFinite(capacity) || capacity <= 0) return null;
            cells *= Math.floor(capacity);
            if (!Number.isSafeInteger(cells)) return null;
        }
        return cells;
    }

    function getFunctionForLocal(decl, functionRangeMaps) {
        if (!decl || !functionRangeMaps) return null;
        const lineNumber = decl.lineNumber ?? -1;
        if (!Number.isInteger(lineNumber) || lineNumber < 0) return null;
        const byLine = functionRangeMaps.byLine || [];
        return byLine[lineNumber]?.func || null;
    }

    function collectFunctionDynamicIssues(rootCtx, functionDecl, locals, limit, analysisCache) {
        if (!functionDecl || !locals.length) return EMPTY_ISSUES;
        const events = [];
        let order = 0;

        for (const decl of locals) {
            const size = getDeclCellSize(decl, rootCtx, analysisCache);
            if (!Number.isFinite(size) || size <= 0) continue;
            const startLine = decl.lineNumber ?? -1;
            if (!Number.isInteger(startLine) || startLine < 0) continue;
            const endLine = Number.isInteger(decl.scopeEndLine)
                ? Math.max(startLine, decl.scopeEndLine)
                : startLine;
            const eventOrder = order++;
            events.push({ line: startLine, kind: -1, order: eventOrder, decl, size });
            events.push({ line: endLine + 1, kind: 1, order: eventOrder, size });
        }

        if (!events.length) return EMPTY_ISSUES;
        events.sort((left, right) =>
            (left.line - right.line) ||
            (left.kind - right.kind) ||
            (left.order - right.order)
        );

        const issues = [];
        let currentCells = 0;
        for (const event of events) {
            if (event.kind < 0) {
                const nextCells = currentCells + event.size;
                if (currentCells <= limit && nextCells > limit) {
                    issues.push({
                        decl: event.decl,
                        functionDecl,
                        issue: {
                            kind: 'dynamicStackUsageMayExceed',
                            messageKey: 'validation.dynamicStackUsageMayExceed',
                            params: {
                                name: event.decl.name || '',
                                function: functionDecl.name || '',
                                usage: nextCells,
                                limit
                            },
                            severity: 'warning'
                        }
                    });
                }
                currentCells = nextCells;
            } else {
                currentCells = Math.max(0, currentCells - event.size);
            }
        }

        return issues;
    }

    function collectDynamicUsageIssues(rootCtx, options = {}) {
        const parsedDecls = rootCtx?.parsedDecls || null;
        if (!parsedDecls) return EMPTY_ISSUES;
        const functionRangeMaps = options.functionRangeMaps || null;
        if (!functionRangeMaps?.byLine) return EMPTY_ISSUES;

        const analysisCache = options.analysisCache || null;
        const limit = getPragmaDynamicLimit(rootCtx, analysisCache);
        if (!Number.isFinite(limit) || limit < 0) return EMPTY_ISSUES;

        const localsByFunction = new Map();
        for (const decl of parsedDecls.locals || []) {
            const func = getFunctionForLocal(decl, functionRangeMaps);
            if (!func) continue;
            let bucket = localsByFunction.get(func);
            if (!bucket) {
                bucket = [];
                localsByFunction.set(func, bucket);
            }
            bucket.push(decl);
        }

        let issues = null;
        for (const [func, locals] of localsByFunction) {
            const functionIssues = collectFunctionDynamicIssues(rootCtx, func, locals, limit, analysisCache);
            if (!functionIssues.length) continue;
            if (!issues) issues = [];
            issues.push(...functionIssues);
        }
        return issues || EMPTY_ISSUES;
    }

    return {
        collectDynamicUsageIssues,
        getPragmaDynamicLimit
    };
}

module.exports = { createDynamicUsageDiagnostics };
