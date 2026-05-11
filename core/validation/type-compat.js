const { isAnyPawnTagName } = require('../syntax/tags');
const { getEnumMemberTagNameForExpression } = require('./enum-member-tag-compat');

function createTypeCompatCore(deps) {
    const {
        explainArrayShapeIssue,
        explainPawnTagCompat,
        findLocalDeclByNameFromSources,
        findUnresolvedReferenceNames,
        getActiveCtrlChar,
        getArrayShapeIssue,
        getRootTagCastExpressionForValidation,
        inferArgType,
        inferArrayLikeCallReturnType,
        isImplicitBoolToScalarCompat,
        parseBraceArrayLiteralExpression,
        parseIndexedAccessExpression,
        parseParamMeta,
        parseUnionTagOptions,
        resolveIndexedAccessValidationChain,
        stripTagCastsForValidation,
        t
    } = deps;

    function explainTypeCompat(paramStr, actualTag, actualDims, actualExpr = '', decls = [], options = {}) {
        const { paramMeta = null, analysisCache = null, allowArrayToScalar = false } = options;
        const compatCacheKey = analysisCache
            ? [
                String(paramStr || ''),
                String(actualTag || ''),
                String(actualDims || ''),
                String(actualExpr || ''),
                allowArrayToScalar ? 'array-ok' : ''
            ].join('\u0000')
            : '';
        if (compatCacheKey && analysisCache.typeCompatByKey.has(compatCacheKey)) {
            return analysisCache.typeCompatByKey.get(compatCacheKey);
        }
        const {
            expectedTag,
            expectedDims,
            hasDefault
        } = paramMeta || analysisCache?.getParamMeta(paramStr) || parseParamMeta(paramStr);
        const actual = String(actualExpr || '').trim();
        const actualRootTagCast = getRootTagCastExpressionForValidation(actual, getActiveCtrlChar());
        const explicitUntypedActual = actualRootTagCast?.tag === '_';
        const isUntaggedBraceArrayActual = !!(
            actual &&
            !actualRootTagCast &&
            actual[0] === '{' &&
            parseBraceArrayLiteralExpression(actual)
        );
        const result = (() => {
            if (!actual || actual === '_') {
                return hasDefault
                    ? { status: 'ok', reason: '' }
                    : { status: 'error', reason: t('validation.argumentHasNoDefaultValue') };
            }

            const unresolvedRefs = findUnresolvedReferenceNames(actual, decls, analysisCache);
            if (unresolvedRefs.length) {
                return {
                    status: 'error',
                    reason: t('validation.unknownSymbol', { symbols: unresolvedRefs.join(', ') })
                };
            }

            const explainEnumMemberTagCompat = () => {
                if (!expectedTag || !actual || actualRootTagCast) return null;
                const enumName = getEnumMemberTagNameForExpression(
                    actual,
                    (name, predicate) => findLocalDeclByNameFromSources(decls, name, predicate, analysisCache)
                );
                if (!enumName) return null;
                const enumTagResult = explainPawnTagCompat(expectedTag, enumName, decls, analysisCache);
                return enumTagResult.status === 'ok' ? enumTagResult : null;
            };

            let effectiveActualTag = actualTag;
            let effectiveActualDims = actualDims;
            let effectiveActualElementTag = '';
            if (expectedDims && !effectiveActualDims) {
                const actualIndexedSource = stripTagCastsForValidation(actual) || actual;
                const indexedExpr = parseIndexedAccessExpression(actualIndexedSource);
                if (indexedExpr) {
                    const baseDecl = findLocalDeclByNameFromSources(
                        decls,
                        indexedExpr.baseName,
                        item => item.type === 'variable',
                        analysisCache
                    );
                    if (baseDecl) {
                        const accessChain = resolveIndexedAccessValidationChain(
                            baseDecl,
                            indexedExpr.accesses.map(access => access.slice(1, -1).trim()),
                            decls,
                            analysisCache
                        );
                        const lastStep = accessChain[accessChain.length - 1] || null;
                        if (
                            lastStep &&
                            !lastStep.nextDimParts?.length &&
                            Array.isArray(lastStep.selectedSourceDimParts) &&
                            lastStep.selectedSourceDimParts.length === 1
                        ) {
                            effectiveActualDims = '[]';
                        }
                    }
                } else {
                    const inferredCallReturnType = inferArrayLikeCallReturnType(actual, decls, analysisCache);
                    if (inferredCallReturnType?.dims) {
                        effectiveActualTag = inferredCallReturnType.tag || effectiveActualTag;
                        effectiveActualDims = inferredCallReturnType.dims;
                    }
                }
            } else if (expectedDims && !effectiveActualTag && actual && !isUntaggedBraceArrayActual) {
                const inferredActualType = inferArgType(actual, decls, analysisCache);
                effectiveActualElementTag = inferredActualType?.elementTag || '';
            }

            if (!expectedDims) {
                if (effectiveActualDims && effectiveActualDims !== '[]' && !allowArrayToScalar) {
                    return { status: 'warn', reason: t('validation.unexpectedDimensions', { dims: effectiveActualDims }) };
                }
                if (isImplicitBoolToScalarCompat(expectedTag, effectiveActualTag, effectiveActualDims)) {
                    return { status: 'ok', reason: '' };
                }
                if (explicitUntypedActual) {
                    return { status: 'ok', reason: '' };
                }
                const enumMemberTagCompat = explainEnumMemberTagCompat();
                if (enumMemberTagCompat) return enumMemberTagCompat;
                return explainPawnTagCompat(expectedTag, effectiveActualTag, decls, analysisCache);
            }

            if (!effectiveActualDims) return { status: 'error', reason: t('validation.expectedArrayStructArgument') };

            const shapeIssue = getArrayShapeIssue(
                expectedDims,
                effectiveActualDims,
                actual,
                decls,
                analysisCache,
                { escapeChar: getActiveCtrlChar() }
            );
            if (shapeIssue) {
                return explainArrayShapeIssue(shapeIssue, expectedDims, effectiveActualDims);
            }

            if (explicitUntypedActual) {
                return { status: 'ok', reason: '' };
            }

            return explainPawnTagCompat(
                expectedTag,
                expectedTag && !effectiveActualTag ? effectiveActualElementTag : effectiveActualTag,
                decls,
                analysisCache
            );
        })();
        if (compatCacheKey) {
            analysisCache.typeCompatByKey.set(compatCacheKey, result);
        }
        return result;
    }

    function checkTypeCompat(paramStr, actualTag, actualDims, actualExpr = '', decls = [], options = {}) {
        return explainTypeCompat(paramStr, actualTag, actualDims, actualExpr, decls, options).status;
    }

    function explainParamDeclCompat(expectedParamStr, actualParamStr, decls = [], options = {}) {
        const { analysisCache = null } = options;
        const expectedMeta = analysisCache?.getParamMeta(expectedParamStr) || parseParamMeta(expectedParamStr);
        const actualMeta = analysisCache?.getParamMeta(actualParamStr) || parseParamMeta(actualParamStr);

        if (!actualMeta?.raw) return { status: 'error', reason: t('validation.missingLocalParameterDeclaration') };
        const unresolvedExpectedDims = findUnresolvedReferenceNames(expectedMeta.expectedDims || '', decls, analysisCache);
        if (unresolvedExpectedDims.length) {
            return {
                status: 'error',
                reason: t('validation.unknownDimensionSymbolIncludeDeclaration', { symbols: unresolvedExpectedDims.join(', ') })
            };
        }
        const unresolvedActualDims = findUnresolvedReferenceNames(actualMeta.expectedDims || '', decls, analysisCache);
        if (unresolvedActualDims.length) {
            return {
                status: 'error',
                reason: t('validation.unknownDimensionSymbolLocalDeclaration', { symbols: unresolvedActualDims.join(', ') })
            };
        }
        if (!!expectedMeta.isByRef !== !!actualMeta.isByRef) {
            return { status: 'error', reason: t('validation.byRefMismatch') };
        }
        if (!!expectedMeta.isConst !== !!actualMeta.isConst) {
            return { status: 'error', reason: t('validation.constQualifierMismatch') };
        }

        const expectedTag = expectedMeta.expectedTag || '';
        const actualTag = actualMeta.expectedTag || '';
        const expectedDims = expectedMeta.expectedDims || '';
        const actualDims = actualMeta.expectedDims || '';

        const isAnyTag = isAnyPawnTagName(expectedTag);
        const isActualAnyTag = isAnyPawnTagName(actualTag);

        if (!expectedTag || expectedTag === '_' || isAnyTag) {
            if (expectedDims) {
                if (!actualDims) return { status: 'error', reason: t('validation.expectedArrayStructParameter') };
            } else {
                if (actualDims) return { status: 'error', reason: t('validation.expectedScalarParameterGotArrayStruct') };
                if (isImplicitBoolToScalarCompat(expectedTag, actualTag, actualDims)) {
                    return { status: 'ok', reason: '' };
                }
                if (actualTag && !isActualAnyTag && !isAnyTag) {
                    return { status: 'error', reason: t('validation.unexpectedTag', { tag: actualTag }) };
                }
            }
        } else {
            const expectedUnionTags = parseUnionTagOptions(expectedTag);
            if (expectedUnionTags.length) {
                const allowedTags = expectedUnionTags.map(tag => tag.toLowerCase());
                if (!actualTag) {
                    return allowedTags.includes('_')
                        ? { status: 'ok', reason: '' }
                        : { status: 'warn', reason: t('validation.expectedTag', { tag: expectedTag }) };
                }
                if (!allowedTags.includes(String(actualTag).toLowerCase())) {
                    if (isActualAnyTag) {
                        return { status: 'ok', reason: '' };
                    }
                    return { status: 'error', reason: t('validation.tagMismatch', { expected: expectedTag, actual: actualTag }) };
                }
            } else {
                if (!actualTag) return { status: 'error', reason: t('validation.missingTag', { tag: expectedTag }) };
                if (isActualAnyTag) return { status: 'ok', reason: '' };
                if (expectedTag.toLowerCase() !== actualTag.toLowerCase()) {
                    return { status: 'error', reason: t('validation.tagMismatch', { expected: expectedTag, actual: actualTag }) };
                }
            }
        }

        if (!expectedDims) {
            return actualDims
                ? { status: 'error', reason: t('validation.unexpectedDimensions', { dims: actualDims }) }
                : { status: 'ok', reason: '' };
        }

        if (!actualDims) return { status: 'error', reason: t('validation.missingDimensions', { dims: expectedDims }) };

        const shapeIssue = getArrayShapeIssue(
            expectedDims,
            actualDims,
            '',
            decls,
            analysisCache,
            { escapeChar: getActiveCtrlChar() }
        );
        if (shapeIssue) {
            return explainArrayShapeIssue(shapeIssue, expectedDims, actualDims);
        }

        return { status: 'ok', reason: '' };
    }

    function checkParamDeclCompat(expectedParamStr, actualParamStr, decls = [], options = {}) {
        return explainParamDeclCompat(expectedParamStr, actualParamStr, decls, options).status;
    }

    return {
        checkParamDeclCompat,
        checkTypeCompat,
        explainParamDeclCompat,
        explainTypeCompat
    };
}

module.exports = { createTypeCompatCore };
