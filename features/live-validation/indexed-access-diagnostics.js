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

    function collectIndexedAccessLiveDiagnosticsForLine(document, lineNumber, ctx, analysisCache, lineStartOffset, docLength, declarationSourceState = null, indexedExpressions = null) {
        const diagnostics = [];
        const includeDocument = isIncludeDocument(document);
        const analysisDecls = analysisCache ? [] : ctx.allDecls;
        const expressions = Array.isArray(indexedExpressions) ? indexedExpressions : [];
        if (!expressions.length) return diagnostics;
        const shouldSkipIncludeContextDependentAccess = (() => {
            const cache = new Map();
            return variableDecl => {
                if (!includeDocument || !variableDecl?.dims) return false;
                const cacheKey = `${variableDecl.name || ''}|${variableDecl.dims || ''}|${variableDecl.lineNumber ?? -1}`;
                if (cache.has(cacheKey)) return cache.get(cacheKey);
                const hasUnresolvedDim = parseDimsParts(variableDecl.dims || '').some(part => {
                    const dimSpec = analysisCache?.getDimSpec?.(part) ||
                        parseDimSpec(part, analysisDecls, new Set(), analysisCache);
                    return !!dimSpec?.raw && dimSpec.capacity == null;
                });
                cache.set(cacheKey, hasUnresolvedDim);
                return hasUnresolvedDim;
            };
        })();
        const shouldSkipIncludeContextDependentIndexExpr = (() => {
            const cache = new Map();
            return actualExpr => {
                if (!includeDocument) return false;
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
        })();
        for (const expr of expressions) {
            const declarationVariableDecl = findDocumentVariableDeclByName(ctx, expr.baseName, lineNumber);
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
