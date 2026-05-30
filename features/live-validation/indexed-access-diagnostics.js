const { getTypeAnalysisSourceDecls } = require('../../core/validation/type-analysis-cache');

function createIndexedAccessDiagnostics(deps) {
    const {
        areWarningDiagnosticsEnabled,
        createLiveValidationDiagnostic,
        createOffsetRange,
        explainIndexedAccessDimCompat,
        findDocumentVariableDeclByName,
        findUnresolvedReferenceNames,
        findVariableDeclarationSpanInRange,
        getTypeCompatSeverity,
        isIncludeDocument,
        parseDimSpec,
        parseDimsParts,
        resolveIndexedAccessValidationChain,
        shouldSuppressVariableDeclarationValidationInRange,
        t
    } = deps;

    const neverSkipIncludeContextDependentAccess = () => false;
    const neverSkipIncludeContextDependentIndexExpr = () => false;

    function collectIndexedAccessLiveDiagnosticsForLine(document, lineNumber, ctx, analysisCache, lineStartOffset, docLength, declarationSourceState = null, indexedExpressions = null) {
        const diagnostics = [];
        const includeDocument = isIncludeDocument(document);
        const analysisDecls = getTypeAnalysisSourceDecls(ctx, analysisCache);
        const expressions = Array.isArray(indexedExpressions) ? indexedExpressions : [];
        if (!expressions.length) return diagnostics;
        const shouldSkipIncludeContextDependentAccess = includeDocument ? (() => {
            const cache = new Map();
            return variableDecl => {
                if (!variableDecl?.dims) return false;
                const cacheKey = `${variableDecl.name || ''}|${variableDecl.dims || ''}|${variableDecl.lineNumber ?? -1}`;
                if (cache.has(cacheKey)) return cache.get(cacheKey);
                const hasUnresolvedDim = parseDimsParts(variableDecl.dims || '').some(part => {
                    const dimSpec = analysisCache?.getDimSpec?.(part) ||
                        parseDimSpec(part, analysisDecls, null, analysisCache);
                    return !!dimSpec?.raw && dimSpec.capacity == null;
                });
                cache.set(cacheKey, hasUnresolvedDim);
                return hasUnresolvedDim;
            };
        })() : neverSkipIncludeContextDependentAccess;
        const shouldSkipIncludeContextDependentIndexExpr = includeDocument ? (() => {
            const cache = new Map();
            return actualExpr => {
                const source = String(actualExpr || '');
                if (source.indexOf('(') < 0) return false;
                if (cache.has(source)) return cache.get(source);
                const unresolvedNames = findUnresolvedReferenceNames(
                    source,
                    analysisDecls,
                    analysisCache,
                    ctx.resolver.ctrlCharAtLine(lineNumber)
                );
                const shouldSkip = unresolvedNames.length > 0;
                cache.set(source, shouldSkip);
                return shouldSkip;
            };
        })() : neverSkipIncludeContextDependentIndexExpr;
        for (const expr of expressions) {
            const declarationVariableDecl = findDocumentVariableDeclByName(ctx, expr.baseName, lineNumber, { sameLineOnly: true });
            if (declarationVariableDecl && findVariableDeclarationSpanInRange(
                document,
                lineStartOffset + expr.baseStart,
                lineStartOffset + expr.end,
                declarationVariableDecl,
                ctx.resolver,
                ctx.text,
                declarationSourceState,
                expr.baseName,
                lineNumber,
                lineNumber
            )) {
                continue;
            }

            const variableDecl = ctx.lookup.findVariable(expr.baseName);
            if (!variableDecl) continue;
            if (!variableDecl.dims) {
                for (const access of expr.accesses) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createOffsetRange(
                                document,
                                lineStartOffset + access.start,
                                lineStartOffset + access.end,
                                docLength
                            ),
                            t('validation.extraIndexAccess')
                        )
                    );
                }
                continue;
            }
            if (shouldSkipIncludeContextDependentAccess(variableDecl)) continue;

            if (
                variableDecl !== declarationVariableDecl &&
                shouldSuppressVariableDeclarationValidationInRange(
                    document,
                    lineStartOffset + expr.baseStart,
                    lineStartOffset + expr.end,
                    ctx,
                    variableDecl,
                    declarationSourceState,
                    expr.baseName,
                    lineNumber,
                    lineNumber
                )
            ) {
                continue;
            }

            const accessChain = resolveIndexedAccessValidationChain(
                variableDecl,
                expr.accesses.map(access => access.text.slice(1, -1).trim()),
                analysisDecls,
                analysisCache
            );
            for (let index = 0; index < Math.min(expr.accesses.length, accessChain.length); index++) {
                const access = expr.accesses[index];
                const actualExpr = access.text.slice(1, -1).trim();
                const expectedDimPart = accessChain[index]?.expectedDimPart;
                if (expectedDimPart == null) break;

                const result = explainIndexedAccessDimCompat(expectedDimPart, actualExpr, analysisDecls, {
                    analysisCache
                });
                if (result.status === 'error' || (result.status === 'warn' && areWarningDiagnosticsEnabled())) {
                    if (shouldSkipIncludeContextDependentIndexExpr(actualExpr)) {
                        continue;
                    }
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createOffsetRange(
                                document,
                                lineStartOffset + access.start,
                                lineStartOffset + access.end,
                                docLength
                            ),
                            result.reason,
                            getTypeCompatSeverity(result.status)
                        )
                    );
                }
            }

            if (expr.accesses.length > accessChain.length || accessChain.some(step => step.expectedDimPart == null)) {
                let firstExtraIndex = accessChain.findIndex(step => step.expectedDimPart == null);
                if (firstExtraIndex < 0) firstExtraIndex = accessChain.length;
                for (let index = firstExtraIndex; index < expr.accesses.length; index++) {
                    const access = expr.accesses[index];
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createOffsetRange(
                                document,
                                lineStartOffset + access.start,
                                lineStartOffset + access.end,
                                docLength
                            ),
                            t('validation.extraIndexAccess')
                        )
                    );
                }
            }
        }

        return diagnostics;
    }

    return {
        collectIndexedAccessLiveDiagnosticsForLine
    };
}

module.exports = { createIndexedAccessDiagnostics };
