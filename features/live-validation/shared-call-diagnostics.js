function createSharedCallDiagnostics(deps) {
    const {
        t,
        collectIndexedAccessExpressionsFromLine,
        resolveIndexedAccessValidationChain,
        createOffsetRange,
        createLiveValidationDiagnostic,
        findVariableDeclByName,
        parseParamMeta,
        stripTrailingSemicolon,
        findTopLevelAssignmentOperatorIndex,
        getAssignmentOperatorText,
        findFirstNonWhitespaceIndex,
        findBalancedGroupEnd,
        readIdentifierAt,
        isOperatorOverloadName,
        getRedundantSizeofDefaultIssue,
        areWarningDiagnosticsEnabled,
        getWarningSeverity
    } = deps;

    function findActualExpressionOffsetInArgPiece(rawArgPiece, actualExpr) {
        const pieceText = String(rawArgPiece?.text || '');
        const actualText = String(actualExpr || '').trim();
        if (!pieceText || !actualText) return 0;
        const directIndex = pieceText.indexOf(actualText);
        if (directIndex >= 0) return directIndex;
        const lastIndex = pieceText.lastIndexOf(actualText);
        return lastIndex >= 0 ? lastIndex : 0;
    }



    function findIndexedArgumentIssueAccess(source, paramMeta, ctx, analysisDecls, analysisCache, options = {}) {
        if (!source) return null;
        const escapeChar = ctx?.resolver?.ctrlCharAtLine?.(0) || '';
        const indexedExpressions = collectIndexedAccessExpressionsFromLine(source, escapeChar);
        if (!indexedExpressions.length) return null;

        let best = null;
        for (const expr of indexedExpressions) {
            if (!best || expr.accesses.length > best.accesses.length) best = expr;
        }
        if (!best?.baseName || !best.accesses?.length) return null;
        if (
            options.requireWholeExpression &&
            (
                best.start !== 0 ||
                best.end !== String(source || '').trim().length
            )
        ) {
            return null;
        }

        const baseDecl = findVariableDeclByName(ctx, analysisCache, best.baseName);
        if (!baseDecl?.dims) return null;

        const accessChain = resolveIndexedAccessValidationChain(
            baseDecl,
            best.accesses.map(access => access.text.slice(1, -1).trim()),
            analysisDecls,
            analysisCache
        );
        if (!accessChain.length) return null;

        const expectedDims = paramMeta?.expectedDims || '';
        let targetIndex = -1;
        if (expectedDims) {
            targetIndex = accessChain.findIndex(step => step?.expectedDimPart == null);
            if (targetIndex < 0) {
                targetIndex = accessChain.findIndex(step =>
                    Array.isArray(step?.nextDimParts) &&
                    step.nextDimParts.length === 0
                );
            }
            if (targetIndex < 0) targetIndex = Math.min(best.accesses.length - 1, accessChain.length - 1);
        } else {
            targetIndex = Math.min(best.accesses.length - 1, accessChain.length - 1);
        }

        const access = best.accesses[targetIndex] || best.accesses[best.accesses.length - 1] || null;
        return access ? { access, indexedExpr: best } : null;
    }



    function getCallArgumentIssueRange(document, rawArgPiece, actualExpr, paramMeta, ctx, analysisDecls, analysisCache, docLength, issueKind = '') {
        if (!rawArgPiece) return null;
        const actualOffset = findActualExpressionOffsetInArgPiece(rawArgPiece, actualExpr);
        const actualSource = String(actualExpr || '').trim();
        const shouldTargetIndexedAccess =
            issueKind === 'byRefArgumentMismatch' ||
            issueKind === 'arrayMustBeIndexed' ||
            issueKind === 'arrayShape' ||
            issueKind === 'typeCompat' ||
            issueKind === 'variadicTypeCompat';
        const indexedIssue = shouldTargetIndexedAccess
            ? findIndexedArgumentIssueAccess(actualSource, paramMeta, ctx, analysisDecls, analysisCache, {
                requireWholeExpression: issueKind === 'byRefArgumentMismatch'
            })
            : null;
        if (indexedIssue?.access) {
            const baseOffset = rawArgPiece.startOffset + actualOffset;
            return createOffsetRange(
                document,
                baseOffset + indexedIssue.access.start,
                baseOffset + indexedIssue.access.end,
                docLength
            );
        }
        return createOffsetRange(document, rawArgPiece.startOffset, rawArgPiece.endOffset, docLength);
    }



    function getHeaderParamMeta(paramText, analysisCache = null) {
        const cachedMeta = analysisCache?.getParamMeta?.(paramText);
        if (cachedMeta) return cachedMeta;
        return parseParamMeta(paramText);
    }



    function parseSizeofTagofDefaultExpression(defaultText) {
        const source = stripTrailingSemicolon(defaultText);
        const operatorMatch = source.match(/^(sizeof|tagof)\b/);
        if (!operatorMatch) return null;

        const operator = operatorMatch[1];
        let index = operatorMatch[0].length;
        const skipWhitespace = () => {
            index = findFirstNonWhitespaceIndex(source, index);
        };
        skipWhitespace();

        let parenDepth = 0;
        while (source[index] === '(') {
            parenDepth++;
            index++;
            skipWhitespace();
        }

        const symbol = readIdentifierAt(source, index);
        if (!symbol) return null;
        const symbolName = symbol.text;
        index = symbol.end;
        skipWhitespace();

        let indexedLevel = 0;
        while (source[index] === '[') {
            const closeIndex = findBalancedGroupEnd(source, index, '[', ']');
            if (closeIndex < 0) {
                return {
                    operator,
                    symbolName,
                    level: indexedLevel,
                    invalidSubscript: true
                };
            }
            const inside = source.slice(index + 1, closeIndex).trim();
            if (inside) {
                return {
                    operator,
                    symbolName,
                    level: indexedLevel,
                    invalidSubscript: true
                };
            }
            indexedLevel++;
            index = closeIndex + 1;
            skipWhitespace();
        }

        while (parenDepth > 0) {
            if (source[index] !== ')') {
                return {
                    operator,
                    symbolName,
                    level: indexedLevel,
                    invalidSubscript: true
                };
            }
            parenDepth--;
            index++;
            skipWhitespace();
        }

        if (source.slice(index).trim()) {
            return {
                operator,
                symbolName,
                level: indexedLevel,
                invalidSubscript: true
            };
        }

        return {
            operator,
            symbolName,
            level: indexedLevel
        };
    }



    function collectDefaultParamLiveDiagnostics(document, functionDecl, localArgPieces, analysisCache, docLength) {
        const diagnostics = [];
        if (!Array.isArray(localArgPieces) || !localArgPieces.length) return diagnostics;
        const paramInfos = localArgPieces.map(piece => {
            const text = String(piece?.text || '').trim();
            const assignmentIndex = text.indexOf('=') >= 0
                ? findTopLevelAssignmentOperatorIndex(text)
                : -1;
            const hasDefault = assignmentIndex >= 0;
            const defaultText = hasDefault
                ? text.slice(assignmentIndex + getAssignmentOperatorText(text, assignmentIndex).length).trim()
                : '';
            return {
                piece,
                text,
                meta: getHeaderParamMeta(text, analysisCache),
                hasDefault,
                defaultText,
                defaultOperator: hasDefault ? parseSizeofTagofDefaultExpression(defaultText) : null
            };
        });
        const paramsByName = new Map();
        for (const info of paramInfos) {
            if (info.meta?.name && !paramsByName.has(info.meta.name)) {
                paramsByName.set(info.meta.name, info);
            }
        }
        const isPublicFunction = functionDecl?.type === 'public';
        const isOperatorFunction = isOperatorOverloadName(functionDecl?.name || '');

        const pushParamDiagnostic = (info, message, severity = null) => {
            if (!info?.piece) return;
            diagnostics.push(
                createLiveValidationDiagnostic(
                    createOffsetRange(
                        document,
                        info.piece.startOffset,
                        info.piece.endOffset,
                        docLength
                    ),
                    message,
                    severity
                )
            );
        };

        for (const info of paramInfos) {
            if (!info.hasDefault) continue;
            const paramName = info.meta?.name || '';
            if (isPublicFunction || isOperatorFunction) {
                pushParamDiagnostic(
                    info,
                    t('validation.functionArgumentMayNotHaveDefaultValue', { name: paramName })
                );
            }

            const defaultOperator = info.defaultOperator;
            if (!defaultOperator) continue;

            if (info.meta?.isByRef) {
                pushParamDiagnostic(
                    info,
                    t('validation.functionArgumentMayNotBeReferenceOrArray', { name: paramName })
                );
                continue;
            }

            const referencedParam = paramsByName.get(defaultOperator.symbolName) || null;
            if (!referencedParam) {
                pushParamDiagnostic(
                    info,
                    t('validation.unknownSymbol', { symbols: defaultOperator.symbolName })
                );
                continue;
            }

            const referencedDims = referencedParam.meta?.expectedDimParts || [];
            const hasTooManyEmptySubscripts =
                defaultOperator.level > 0 && defaultOperator.level >= referencedDims.length;
            if (defaultOperator.invalidSubscript || hasTooManyEmptySubscripts) {
                pushParamDiagnostic(
                    info,
                    t('validation.invalidSubscript', { name: defaultOperator.symbolName })
                );
                continue;
            }

            if (defaultOperator.operator === 'tagof' && defaultOperator.level > 0) {
                pushParamDiagnostic(
                    info,
                    t('validation.cannotTakeTagAsDefaultForIndexedArrayParameter', { name: paramName })
                );
                continue;
            }

            const redundantSizeofIssue = typeof getRedundantSizeofDefaultIssue === 'function'
                ? getRedundantSizeofDefaultIssue(defaultOperator, referencedParam.meta)
                : null;
            if (redundantSizeofIssue && areWarningDiagnosticsEnabled?.()) {
                pushParamDiagnostic(
                    info,
                    t(redundantSizeofIssue.messageKey || 'validation.redundantSizeof', redundantSizeofIssue.params || { name: defaultOperator.symbolName }),
                    getWarningSeverity?.()
                );
            }
        }

        return diagnostics;
    }

    return {
        getCallArgumentIssueRange,
        getHeaderParamMeta,
        collectDefaultParamLiveDiagnostics
    };
}

module.exports = { createSharedCallDiagnostics };
