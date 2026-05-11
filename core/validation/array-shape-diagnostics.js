const { getPawnIdentifierName } = require('../syntax/identifiers');

function createArrayShapeDiagnosticsCore(deps) {
    const {
        findAnyDeclByNameFromSources,
        getActiveCtrlChar,
        isResolvedDimSpec,
        measurePawnStringLiteral,
        normalizeEnumName,
        parseDimSpec,
        parseDimsParts,
        semanticSyntaxCore,
        t,
        unwrapOuterParens
    } = deps;

    function stripTagsForArrayShape(source) {
        let value = unwrapOuterParens(source);
        while (true) {
            const stripped = semanticSyntaxCore.stripRootTagCasts(value, { escapeChar: getActiveCtrlChar() });
            if (!stripped || stripped === value) break;
            value = unwrapOuterParens(stripped);
        }
        return String(value || '').trim();
    }

    function resolveStringArrayValueExpression(source, decls, analysisCache, seen = new Set()) {
        const expr = stripTagsForArrayShape(source);
        if (!expr) return '';
        if (expr.startsWith('"')) return expr;
        const name = getPawnIdentifierName(expr);
        if (!name || seen.has(name)) return '';
        const decl = findAnyDeclByNameFromSources(decls, name, null, analysisCache);
        if (!decl) return '';
        if (decl.type === 'define' && !decl.args) {
            seen.add(name);
            const resolved = resolveStringArrayValueExpression(decl.value, decls, analysisCache, seen);
            seen.delete(name);
            return resolved;
        }
        if (decl.type === 'variable') {
            const value = String(decl.value || '').trim();
            if (!value) return '';
            seen.add(name);
            const resolved = resolveStringArrayValueExpression(value, decls, analysisCache, seen);
            seen.delete(name);
            return resolved;
        }
        return '';
    }

    function isStringArrayValueExpression(source, decls, analysisCache) {
        return !!resolveStringArrayValueExpression(source, decls, analysisCache);
    }

    function getDimSpecForComparison(dimPart, decls, analysisCache) {
        return analysisCache?.getDimSpec?.(dimPart) ||
            parseDimSpec(dimPart, decls, new Set(), analysisCache);
    }

    function getArrayShapeIssue(expectedDims, actualDims, actualExpr = '', decls = [], analysisCache = null, options = {}) {
        const expectedParts = parseDimsParts(expectedDims || '');
        const actualParts = parseDimsParts(actualDims || '');
        if (!expectedParts.length) {
            return actualParts.length
                ? { kind: 'unexpectedArray', status: 'error' }
                : null;
        }
        const actualSource = String(actualExpr || '').trim();
        const escapeChar = typeof options === 'string'
            ? options
            : (options?.escapeChar ?? getActiveCtrlChar());
        const expectedSingleSpec = expectedParts.length === 1
            ? getDimSpecForComparison(expectedParts[0], decls, analysisCache)
            : null;
        const actualStringLiteral = expectedParts.length === 1
            ? resolveStringArrayValueExpression(actualSource, decls, analysisCache)
            : '';
        if (actualStringLiteral) {
            if (!actualParts.length || actualParts.length === 1) {
                const measured = measurePawnStringLiteral(actualStringLiteral, escapeChar);
                if (
                    expectedSingleSpec?.capacity != null &&
                    measured?.bytesWithTerminator != null &&
                    measured.bytesWithTerminator > expectedSingleSpec.capacity
                ) {
                    return {
                        kind: 'size',
                        status: 'error',
                        expectedRaw: expectedSingleSpec.raw,
                        actualRaw: String(measured.bytesWithTerminator)
                    };
                }
                return null;
            }
        }
        if (!actualParts.length) {
            if (options?.allowScalarAssignmentToArrayField) return null;
            return { kind: 'missingArray', status: 'error' };
        }
        if (expectedParts.length !== actualParts.length) {
            return { kind: 'dimensionCount', status: 'error' };
        }
        for (let index = 0; index < expectedParts.length; index++) {
            if (!expectedParts[index]) continue;
            const expectedSpec = getDimSpecForComparison(expectedParts[index], decls, analysisCache);
            const actualSpec = getDimSpecForComparison(actualParts[index], decls, analysisCache);
            const expectedEnum = normalizeEnumName(expectedSpec?.enumName || '');
            const actualEnum = normalizeEnumName(actualSpec?.enumName || '');
            if (expectedEnum && actualEnum && expectedEnum !== actualEnum) {
                return {
                    kind: 'indexTag',
                    status: 'warn',
                    name: actualSpec?.enumName || actualSpec?.raw || expectedSpec?.enumName || expectedSpec?.raw || ''
                };
            }
            if (expectedSpec?.raw && !actualSpec?.raw) {
                return {
                    kind: 'expectedOnly',
                    status: 'warn',
                    expectedRaw: expectedSpec.raw,
                    actualRaw: actualSpec?.raw || ''
                };
            }
            if (!isResolvedDimSpec(expectedSpec) || !isResolvedDimSpec(actualSpec)) {
                return {
                    kind: 'unknownDimensionSymbol',
                    status: 'error',
                    expectedRaw: expectedSpec?.raw || '',
                    actualRaw: actualSpec?.raw || ''
                };
            }
            if (
                expectedSpec?.raw &&
                actualSpec?.raw &&
                expectedSpec.capacity != null &&
                actualSpec.capacity != null
            ) {
                if (expectedSpec.capacity === actualSpec.capacity) {
                    continue;
                }
                if (
                    options?.arrayContext === 'assignment' &&
                    expectedParts.length === 1 &&
                    actualParts.length === 1 &&
                    !expectedEnum &&
                    !actualEnum &&
                    actualSpec.capacity <= expectedSpec.capacity
                ) {
                    continue;
                }
                if (
                    expectedParts.length === 1 &&
                    actualParts.length === 1 &&
                    actualSpec.capacity <= expectedSpec.capacity &&
                    isStringArrayValueExpression(actualSource, decls, analysisCache)
                ) {
                    continue;
                }
                return {
                    kind: 'size',
                    status: 'error',
                    expectedRaw: expectedSpec.raw,
                    actualRaw: actualSpec.raw
                };
            }
            if (expectedSpec?.raw && actualSpec?.raw && expectedSpec.raw !== actualSpec.raw) {
                return {
                    kind: 'rawMismatch',
                    status: 'warn',
                    expectedRaw: expectedSpec.raw,
                    actualRaw: actualSpec.raw
                };
            }
        }
        return null;
    }

    function explainArrayShapeIssue(issue, expectedDims, actualDims) {
        if (!issue) return { status: 'ok', reason: '' };
        switch (issue.kind) {
            case 'missingArray':
                return { status: 'error', reason: t('validation.missingDimensions', { dims: expectedDims }) };
            case 'unexpectedArray':
                return { status: 'warn', reason: t('validation.unexpectedDimensions', { dims: actualDims }) };
            case 'dimensionCount':
                return {
                    status: 'error',
                    reason: t('validation.dimensionCountMismatch', { expected: expectedDims, actual: actualDims })
                };
            case 'expectedOnly':
                return {
                    status: 'warn',
                    reason: t('validation.dimensionMismatchExpectedOnly', { expected: issue.expectedRaw || '' })
                };
            case 'unknownDimensionSymbol':
                return {
                    status: 'error',
                    reason: t('validation.unknownDimensionSymbolExpectedGot', {
                        expected: issue.expectedRaw || '',
                        actual: issue.actualRaw || ''
                    })
                };
            case 'size':
                return {
                    status: 'error',
                    reason: t('validation.dimensionSizeMismatch', {
                        expected: issue.expectedRaw || expectedDims,
                        actual: issue.actualRaw || actualDims
                    })
                };
            case 'indexTag':
                return { status: 'warn', reason: t('validation.indexTagMismatch', { name: issue.name || '' }) };
            case 'rawMismatch':
                return {
                    status: 'warn',
                    reason: t('validation.dimensionMismatchExpectedGot', {
                        expected: issue.expectedRaw || '',
                        actual: issue.actualRaw || ''
                    })
                };
            default:
                return { status: issue.status || 'error', reason: '' };
        }
    }

    function explainArrayShapeDiagnosticIssue(issue) {
        if (!issue) return { status: 'ok', reason: '' };
        switch (issue.kind) {
            case 'missingArray':
                return { status: issue.status || 'error', reason: t('validation.mustBeAssignedToArray') };
            case 'unexpectedArray':
                return {
                    status: issue.status || 'error',
                    reason: t('validation.arrayMustBeIndexed', { name: issue.name || '' })
                };
            case 'dimensionCount':
                return { status: issue.status || 'error', reason: t('validation.arrayDimensionsMustMatch') };
            case 'size':
                return { status: issue.status || 'error', reason: t('validation.arraySizesMustMatch') };
            case 'indexTag':
                return {
                    status: issue.status || 'warn',
                    reason: t('validation.indexTagMismatch', { name: issue.name || '' })
                };
            case 'expectedOnly':
            case 'rawMismatch':
            case 'unknownDimensionSymbol':
                return { status: issue.status || 'warn', reason: t('validation.arraySizesMustMatch') };
            default:
                return { status: issue.status || 'error', reason: '' };
        }
    }

    return {
        explainArrayShapeDiagnosticIssue,
        explainArrayShapeIssue,
        getArrayShapeIssue
    };
}

module.exports = { createArrayShapeDiagnosticsCore };
