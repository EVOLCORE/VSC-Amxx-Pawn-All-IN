function createDeclarationDiagnostics(deps) {
    const {
        areWarningDiagnosticsEnabled,
        createIdentifierDiagnosticForOccurrence,
        createLiveValidationDiagnostic,
        createOffsetRange,
        explainArrayInitializerIssue,
        explainArrayShapeDiagnosticIssue,
        findArrayMustBeIndexedIssue,
        findInvalidArraySizeIssue,
        findTopLevelAssignmentOperatorIndex,
        findUnresolvedReferenceNames,
        getAssignmentOperatorText,
        getConstMutationMessage,
        getExpressionAssignableInfo,
        getLiveArrayShapeIssue,
        getScalarAssignmentTagIssue,
        getNormalizedDeclPath,
        getNormalizedDocumentPath,
        getSelfAssignmentIssue,
        getSymbolTruncationIssue,
        getConstantRedefinitionIssue,
        getVariableShadowingIssue,
        getVariableDeclsForLine,
        getWarningSeverity,
        evaluatePawnNumericExpr,
        inferArgType,
        inferArrayShapeActualType,
        isEscapedQuote,
        isFunctionHeaderLine,
        isSyntacticAssignableExpression,
        isOpenMultilineBraceInitializerForCurrentDecl,
        isOpenMultilineBraceInitializerLine,
        isPreprocessorContinuationLine,
        isSingleStatementForInitLine,
        matchesCurrentDeclarationAssignmentLhs,
        mayHaveInlineStatementPrefix,
        normalizeSelfAssignmentExpression,
        parseStandaloneMutationStatement,
        stripLeadingInlineStatementPrefix,
        stripTrailingSemicolon,
        t
    } = deps;
    const EMPTY_DECLS = [];

    function getAssignmentRhsSourceInfo(ctx, lineText, lineStartOffset, rhsStartInLine, fallbackText, escapeChar) {
        const sourceText = String(ctx?.text || '');
        const fallback = String(fallbackText || '').trim();
        const fallbackStartOffset = lineStartOffset + Math.max(0, rhsStartInLine);
        const fallbackEndOffset = fallbackStartOffset + fallback.length;
        if (!sourceText || fallbackStartOffset < 0 || fallbackStartOffset >= sourceText.length) {
            return { text: fallback, startOffset: fallbackStartOffset, endOffset: fallbackEndOffset };
        }

        const firstLineEndOffset = lineStartOffset + String(lineText || '').length;
        const firstLineSource = sourceText.slice(fallbackStartOffset, firstLineEndOffset);
        if (
            !firstLineSource.includes('(') &&
            !firstLineSource.includes('[') &&
            !firstLineSource.includes('{')
        ) {
            return { text: fallback, startOffset: fallbackStartOffset, endOffset: fallbackEndOffset };
        }

        const expectedClosers = [];
        let inString = false;
        let stringChar = '';
        let lineComment = false;
        let blockComment = false;
        let lastNonWhitespace = fallbackStartOffset - 1;
        let sawOpenGroup = false;

        const isQuoteEscaped = index =>
            typeof isEscapedQuote === 'function'
                ? isEscapedQuote(sourceText, index, escapeChar)
                : sourceText[index - 1] === '\\';

        for (let index = fallbackStartOffset; index < sourceText.length; index++) {
            const char = sourceText[index];
            const next = sourceText[index + 1] || '';

            if (blockComment) {
                if (char === '*' && next === '/') {
                    blockComment = false;
                    index++;
                }
                continue;
            }
            if (lineComment) {
                if (char === '\n') {
                    lineComment = false;
                    if (!expectedClosers.length) break;
                }
                continue;
            }
            if (inString) {
                if (char === stringChar && !isQuoteEscaped(index)) {
                    inString = false;
                }
                if (!/\s/.test(char)) lastNonWhitespace = index;
                continue;
            }

            if (char === '/' && next === '/') {
                lineComment = true;
                index++;
                if (!expectedClosers.length) break;
                continue;
            }
            if (char === '/' && next === '*') {
                blockComment = true;
                index++;
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                lastNonWhitespace = index;
                continue;
            }
            if (char === '(') {
                expectedClosers.push(')');
                sawOpenGroup = true;
                lastNonWhitespace = index;
                continue;
            }
            if (char === '[') {
                expectedClosers.push(']');
                sawOpenGroup = true;
                lastNonWhitespace = index;
                continue;
            }
            if (char === '{') {
                expectedClosers.push('}');
                sawOpenGroup = true;
                lastNonWhitespace = index;
                continue;
            }
            if (char === ')' || char === ']' || char === '}') {
                if (expectedClosers[expectedClosers.length - 1] === char) {
                    expectedClosers.pop();
                }
                lastNonWhitespace = index;
                continue;
            }
            if ((char === '\r' || char === '\n' || char === ';') && !expectedClosers.length) {
                break;
            }
            if (!/\s/.test(char)) {
                lastNonWhitespace = index;
            }
        }

        if (!sawOpenGroup || lastNonWhitespace < fallbackStartOffset) {
            return { text: fallback, startOffset: fallbackStartOffset, endOffset: fallbackEndOffset };
        }

        const endOffset = Math.max(fallbackStartOffset, lastNonWhitespace + 1);
        const text = sourceText.slice(fallbackStartOffset, endOffset).trim();
        return { text, startOffset: fallbackStartOffset, endOffset };
    }

    function collectDeclarationLiveDiagnosticsForLine(document, lineNumber, ctx, lineText, strippedLineText, lineStartOffset, docLength, analysisCacheOrFactory = null) {
        const diagnostics = [];
        const trimmedLine = String(strippedLineText || lineText || '').trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) return diagnostics;
        if (isFunctionHeaderLine(ctx, lineNumber)) return diagnostics;
        if (isPreprocessorContinuationLine(ctx, lineNumber)) return diagnostics;

        const {
            currentArgs,
            currentLocals,
            currentGlobals
        } = getVariableDeclsForLine(ctx, lineNumber);
        const hasCurrentVariableDecls = !!(
            currentArgs.length ||
            currentLocals.length ||
            currentGlobals.length
        );
        const hasAssignmentChar = String(strippedLineText || '').includes('=');
        const hasMutationOperator = String(strippedLineText || '').includes('++') ||
            String(strippedLineText || '').includes('--');
        if (!hasAssignmentChar && !hasMutationOperator && !hasCurrentVariableDecls) {
            return diagnostics;
        }
        let currentVariableDecls = EMPTY_DECLS;
        if (hasCurrentVariableDecls) {
            const currentDocumentPath = getNormalizedDocumentPath(document);
            currentVariableDecls = [];
            const addCurrentVariableDecls = decls => {
                for (const decl of decls || []) {
                    if (decl?.type !== 'variable') continue;
                    const declPath = getNormalizedDeclPath(decl);
                    if (!declPath || !currentDocumentPath || declPath === currentDocumentPath) {
                        currentVariableDecls.push(decl);
                    }
                }
            };
            addCurrentVariableDecls(currentArgs);
            addCurrentVariableDecls(currentLocals);
            addCurrentVariableDecls(currentGlobals);
        }
        if (!currentVariableDecls.length && !hasAssignmentChar && !hasMutationOperator) {
            return diagnostics;
        }
        let declarationAnalysisCache = null;
        const getDeclarationAnalysisCache = () => {
            if (declarationAnalysisCache) return declarationAnalysisCache;
            declarationAnalysisCache = typeof analysisCacheOrFactory === 'function'
                ? analysisCacheOrFactory()
                : analysisCacheOrFactory;
            return declarationAnalysisCache;
        };
        const escapeChar = ctx.resolver.ctrlCharAtLine(lineNumber);
        const occurrenceByName = new Map();
        const createIdentifierRangeForOccurrence = (name, occurrenceIndex = 0) => {
            const target = String(name || '');
            if (!target) return null;
            let seenCount = 0;
            for (let index = 0; index < lineText.length;) {
                const foundIndex = lineText.indexOf(target, index);
                if (foundIndex < 0) break;
                const before = lineText[foundIndex - 1] || '';
                const after = lineText[foundIndex + target.length] || '';
                if (!/[A-Za-z0-9_@]/.test(before) && !/[A-Za-z0-9_@]/.test(after)) {
                    if (seenCount === occurrenceIndex) {
                        return createOffsetRange(
                            document,
                            lineStartOffset + foundIndex,
                            lineStartOffset + foundIndex + target.length,
                            docLength
                        );
                    }
                    seenCount++;
                }
                index = foundIndex + target.length;
            }
            return null;
        };
        const pushDeclWarning = (decl, issue, occurrenceIndex = 0) => {
            if (!issue || !areWarningDiagnosticsEnabled()) return;
            const range = createIdentifierRangeForOccurrence(decl?.name || issue.params?.name || '', occurrenceIndex);
            if (!range) return;
            diagnostics.push(createLiveValidationDiagnostic(
                range,
                t(issue.messageKey, issue.params || {}),
                getWarningSeverity()
            ));
        };
        const createTargetNameRange = (targetText, targetStart, assignable) => {
            const sourceText = String(targetText || '');
            const start = Number.isInteger(targetStart) && targetStart >= 0 ? targetStart : 0;
            const fallbackEnd = start + Math.max(1, sourceText.length);
            const symbolName = String(assignable?.name || '').trim();
            if (symbolName) {
                const targetEnd = start + sourceText.length;
                const symbolStart = lineText.indexOf(symbolName, start);
                if (symbolStart >= 0 && symbolStart + symbolName.length <= targetEnd) {
                    return createOffsetRange(
                        document,
                        lineStartOffset + symbolStart,
                        lineStartOffset + symbolStart + symbolName.length,
                        docLength
                    );
                }
            }
            return createOffsetRange(
                document,
                lineStartOffset + start,
                lineStartOffset + fallbackEnd,
                docLength
            );
        };

        for (let currentIndex = 0; currentIndex < currentVariableDecls.length; currentIndex++) {
            const decl = currentVariableDecls[currentIndex];
            const sameNameOccurrenceIndex = currentVariableDecls
                .slice(0, currentIndex)
                .filter(item => item?.name === decl?.name).length;
            if (decl?.name) {
                pushDeclWarning(
                    decl,
                    typeof getSymbolTruncationIssue === 'function'
                        ? getSymbolTruncationIssue(decl.name)
                        : null,
                    sameNameOccurrenceIndex
                );
            }
            const priorSameName = (() => {
                const earlierSameLineDecl = currentVariableDecls
                    .slice(0, currentIndex)
                    .find(item => item.name === decl.name);
                if (earlierSameLineDecl) return earlierSameLineDecl;
                if (isSingleStatementForInitLine(lineText, decl.name)) return null;
                if (currentArgs.includes(decl)) {
                    return currentArgs.find(item => item.lineNumber < lineNumber && item.name === decl.name) || null;
                }
                if (currentLocals.includes(decl)) {
                    if (decl.isForVar) {
                        return currentArgs.find(item => item.name === decl.name) || null;
                    }
                    return currentArgs.find(item => item.name === decl.name) ||
                        ctx.parsedDecls.locals.find(item =>
                            item !== decl &&
                            item.name === decl.name &&
                            (item.declDepth ?? 0) === (decl.declDepth ?? 0) &&
                            (item.scopeEndLine ?? item.lineNumber) >= lineNumber &&
                            item.lineNumber < lineNumber &&
                            !isSingleStatementForInitLine(ctx.rawLines?.[item.lineNumber] || '', item.name)
                        ) ||
                        null;
                }
                return ctx.parsedDecls.globals.find(item =>
                    item !== decl &&
                    item.name === decl.name &&
                    item.lineNumber < lineNumber
                ) || null;
            })();
            if (priorSameName) {
                const constantRedefinitionIssue = typeof getConstantRedefinitionIssue === 'function'
                    ? getConstantRedefinitionIssue(priorSameName, decl, {
                        evaluateConstantValue: value => evaluatePawnNumericExpr?.(value, ctx.allDecls)
                    })
                    : null;
                if (constantRedefinitionIssue?.severity === 'silent') {
                    continue;
                }
                if (constantRedefinitionIssue) {
                    pushDeclWarning(decl, constantRedefinitionIssue, sameNameOccurrenceIndex);
                    continue;
                }
                const nextOccurrence = occurrenceByName.get(decl.name) ?? 0;
                occurrenceByName.set(decl.name, nextOccurrence + 1);
                const diagnostic = createIdentifierDiagnosticForOccurrence(
                    document,
                    lineStartOffset,
                    lineText,
                    decl.name,
                    nextOccurrence,
                    docLength,
                    t('validation.symbolAlreadyDefined', { name: decl.name })
                );
                if (diagnostic) diagnostics.push(diagnostic);
            } else if (areWarningDiagnosticsEnabled() && decl?.type === 'variable' && decl.name) {
                const shadowDeclarationKind = currentArgs.includes(decl)
                    ? 'argument'
                    : (currentLocals.includes(decl) ? 'local' : '');
                const shadowedDecl = (() => {
                    if (shadowDeclarationKind === 'argument') {
                        return (ctx.parsedDecls.globals || []).find(item =>
                            item !== decl &&
                            item.name === decl.name &&
                            item.lineNumber < lineNumber
                        ) || null;
                    }
                    if (shadowDeclarationKind !== 'local') return null;
                    return currentArgs.find(item => item.name === decl.name) ||
                        (ctx.parsedDecls.locals || []).find(item =>
                            item !== decl &&
                            item.name === decl.name &&
                            (item.declDepth ?? -1) !== (decl.declDepth ?? -1) &&
                            item.lineNumber < lineNumber
                        ) ||
                        (ctx.parsedDecls.globals || []).find(item =>
                            item !== decl &&
                            item.name === decl.name &&
                            item.lineNumber < lineNumber
                        ) ||
                        null;
                })();
                pushDeclWarning(
                    decl,
                    typeof getVariableShadowingIssue === 'function'
                        ? getVariableShadowingIssue(decl, shadowedDecl, {
                            declarationKind: shadowDeclarationKind
                        })
                        : null,
                    sameNameOccurrenceIndex
                );
            }
        }

        const assignmentSourceLine = String(strippedLineText || '').replace(/^\s*return\b\s*/, '');
        const normalizedAssignmentLine = mayHaveInlineStatementPrefix(assignmentSourceLine)
            ? stripLeadingInlineStatementPrefix(assignmentSourceLine)
            : { text: assignmentSourceLine, startOffset: 0 };
        const assignmentIndex = normalizedAssignmentLine.text.indexOf('=') >= 0
            ? findTopLevelAssignmentOperatorIndex(normalizedAssignmentLine.text)
            : -1;
        if (
            assignmentIndex >= 0 &&
            !/^(?:new|static|const|stock|public|private|native|forward|enum)\b/.test(trimmedLine) &&
            !/^\.\s*[A-Za-z_@]\w*\s*=/.test(trimmedLine)
        ) {
            const lhs = normalizedAssignmentLine.text.slice(0, assignmentIndex).trim();
            const assignmentOperator = getAssignmentOperatorText(normalizedAssignmentLine.text, assignmentIndex);
            const lhsVariableDecl = !lhs.includes('[')
                ? ctx.lookup.findVariable(lhs)
                : null;
            if (
                lhs &&
                matchesCurrentDeclarationAssignmentLhs(lhs, currentVariableDecls, lineNumber)
            ) {
                return diagnostics;
            }
            const lhsLooksAssignable = lhs ? isSyntacticAssignableExpression(lhs) : false;
            let cachedAssignable = null;
            let cachedAnalysisCache = null;
            let cachedAnalysisDecls = null;
            const getAssignmentAnalysis = () => {
                if (!cachedAnalysisCache) {
                    cachedAnalysisCache = getDeclarationAnalysisCache();
                    cachedAnalysisDecls = cachedAnalysisCache ? [] : ctx.allDecls;
                }
                return {
                    analysisCache: cachedAnalysisCache,
                    analysisDecls: cachedAnalysisDecls
                };
            };
            const getAssignable = () => {
                if (cachedAssignable) return cachedAssignable;
                const { analysisCache, analysisDecls } = getAssignmentAnalysis();
                cachedAssignable = getExpressionAssignableInfo(lhs, analysisDecls, analysisCache, { escapeChar });
                return cachedAssignable;
            };
            const createLhsRange = () => {
                const lhsStart = lineText.indexOf(lhs, normalizedAssignmentLine.startOffset);
                return lhsStart >= 0
                    ? createOffsetRange(
                        document,
                        lineStartOffset + lhsStart,
                        lineStartOffset + lhsStart + lhs.length,
                        docLength
                    )
                    : createOffsetRange(
                        document,
                        lineStartOffset,
                        lineStartOffset + Math.max(1, lineText.length),
                        docLength
                    );
            };
            const createConstTargetRange = assignable => {
                const symbolName = String(assignable?.name || '').trim();
                if (!symbolName) return createLhsRange();
                const lhsStart = lineText.indexOf(lhs, normalizedAssignmentLine.startOffset);
                return lhsStart >= 0 ? createTargetNameRange(lhs, lhsStart, assignable) : createLhsRange();
            };
            const createRhsRange = rhs => {
                const rhsStart = lineText.indexOf(rhs, normalizedAssignmentLine.startOffset + assignmentIndex + assignmentOperator.length);
                return rhsStart >= 0
                    ? createOffsetRange(
                        document,
                        lineStartOffset + rhsStart,
                        lineStartOffset + rhsStart + rhs.length,
                        docLength
                    )
                    : createOffsetRange(
                        document,
                        lineStartOffset,
                        lineStartOffset + Math.max(1, lineText.length),
                        docLength
                    );
            };
            const createRhsInfoRange = rhsInfo => {
                if (rhsInfo?.startOffset != null && rhsInfo?.endOffset != null && rhsInfo.endOffset > rhsInfo.startOffset) {
                    return createOffsetRange(document, rhsInfo.startOffset, rhsInfo.endOffset, docLength);
                }
                return createRhsRange(rhsInfo?.text || '');
            };
            const createLhsTagRange = () => {
                const lhsStart = lineText.indexOf(lhs, normalizedAssignmentLine.startOffset);
                if (lhsStart < 0) return createLhsRange();
                let cursor = lhsStart;
                while (cursor < lineText.length && /\s/.test(lineText[cursor] || '')) cursor++;
                let tagEnd = cursor;
                if (!/[A-Za-z_@]/.test(lineText[tagEnd] || '')) return createLhsRange();
                tagEnd++;
                while (tagEnd < lineText.length && /[A-Za-z0-9_@]/.test(lineText[tagEnd] || '')) tagEnd++;
                let colon = tagEnd;
                while (colon < lineText.length && /\s/.test(lineText[colon] || '')) colon++;
                if (lineText[colon] !== ':') return createLhsRange();
                return createOffsetRange(
                    document,
                    lineStartOffset + cursor,
                    lineStartOffset + colon + 1,
                    docLength
                );
            };
            if (lhs && !lhsLooksAssignable) {
                diagnostics.push(
                    createLiveValidationDiagnostic(
                        createLhsRange(),
                        t('validation.mustBeLValue')
                    )
                );
            } else if (lhsLooksAssignable) {
                const assignable = getAssignable();
                if (!assignable.isLValue) {
                    const { analysisCache, analysisDecls } = getAssignmentAnalysis();
                    const unresolvedTargetNames = assignable.name
                        ? findUnresolvedReferenceNames(assignable.name, analysisDecls, analysisCache, escapeChar)
                        : [];
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createConstTargetRange(assignable),
                            unresolvedTargetNames.length
                                ? t('validation.unknownSymbol', { symbols: unresolvedTargetNames.join(', ') })
                                : t('validation.mustBeLValue')
                        )
                    );
                    return diagnostics;
                }
                if (assignable.isConst) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createConstTargetRange(assignable),
                            getConstMutationMessage(assignable, lhs)
                        )
                    );
                }
                if (assignable.dims && assignmentOperator && assignmentOperator !== '=') {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createLhsRange(),
                            t('validation.arrayAssignmentMustBeSimple')
                        )
                    );
                    return diagnostics;
                }
                if (assignmentOperator === '=') {
                    const rhsRawStart = assignmentIndex + assignmentOperator.length;
                    const rhsRawText = normalizedAssignmentLine.text.slice(rhsRawStart);
                    const rhsLeadingWhitespace = rhsRawText.match(/^\s*/)?.[0].length || 0;
                    const rhsStartInLine = normalizedAssignmentLine.startOffset + rhsRawStart + rhsLeadingWhitespace;
                    const rhsSourceInfo = getAssignmentRhsSourceInfo(
                        ctx,
                        lineText,
                        lineStartOffset,
                        rhsStartInLine,
                        rhsRawText.slice(rhsLeadingWhitespace),
                        escapeChar
                    );
                    const rhs = stripTrailingSemicolon(rhsSourceInfo.text);
                    if (
                        areWarningDiagnosticsEnabled() &&
                        rhs &&
                        normalizeSelfAssignmentExpression(lhs) === normalizeSelfAssignmentExpression(rhs)
                    ) {
                        const issue = typeof getSelfAssignmentIssue === 'function'
                            ? getSelfAssignmentIssue(assignable, lhs)
                            : { messageKey: 'validation.selfAssignment', params: { name: assignable.name || lhs } };
                        diagnostics.push(
                            createLiveValidationDiagnostic(
                                createLhsRange(),
                                t(issue.messageKey, issue.params || {}),
                                getWarningSeverity()
                            )
                        );
                    }
                    if (rhs && assignable.dims) {
                        const { analysisCache, analysisDecls } = getAssignmentAnalysis();
                        const { type: actual, callReturn } = inferArrayShapeActualType(rhs, analysisDecls, analysisCache);
                        const shapeIssue = getLiveArrayShapeIssue(
                            assignable.dims,
                            actual?.dims || '',
                            rhs,
                            analysisDecls,
                            analysisCache,
                            {
                                escapeChar,
                                arrayContext: 'assignment',
                                allowScalarAssignmentToArrayField: assignable.allowsScalarAssignmentToArrayField
                            }
                        );
                        const shouldSkipMissingArray =
                            shapeIssue?.kind === 'missingArray' &&
                            (
                                findUnresolvedReferenceNames(rhs, analysisDecls, analysisCache, escapeChar).length > 0 ||
                                (/^[A-Za-z_@]\w*\s*\(/.test(rhs) && !callReturn?.known)
                            );
                        if (shapeIssue && !shouldSkipMissingArray) {
                            diagnostics.push(
                                createLiveValidationDiagnostic(
                                    createRhsInfoRange(rhsSourceInfo),
                                    explainArrayShapeDiagnosticIssue(shapeIssue).reason,
                                    shapeIssue.severity
                                )
                            );
                        }
                    }
                    if (
                        areWarningDiagnosticsEnabled() &&
                        rhs &&
                        typeof getScalarAssignmentTagIssue === 'function'
                    ) {
                        const { analysisCache, analysisDecls } = getAssignmentAnalysis();
                        const tagIssue = getScalarAssignmentTagIssue(lhs, rhs, analysisDecls, analysisCache, {
                            escapeChar,
                            assignable
                        });
                        if (tagIssue) {
                            diagnostics.push(
                                createLiveValidationDiagnostic(
                                    tagIssue.rangeTarget === 'lhsTag'
                                        ? createLhsTagRange()
                                        : createRhsInfoRange(rhsSourceInfo),
                                    tagIssue.reason,
                                    getWarningSeverity()
                                )
                            );
                        }
                    }
                }
            }
            if (lhsVariableDecl && !lhsVariableDecl.dims && assignmentOperator) {
                const rhs = stripTrailingSemicolon(normalizedAssignmentLine.text
                    .slice(assignmentIndex + assignmentOperator.length)
                    .trim());
                if (rhs) {
                    const analysisCache = getDeclarationAnalysisCache();
                    const analysisDecls = analysisCache ? [] : ctx.allDecls;
                    const issue = findArrayMustBeIndexedIssue(rhs, analysisDecls, analysisCache, { escapeChar });
                    if (issue) {
                        const rhsStart = lineText.indexOf(rhs, normalizedAssignmentLine.startOffset + assignmentIndex + assignmentOperator.length);
                        diagnostics.push(
                            createLiveValidationDiagnostic(
                                rhsStart >= 0
                                    ? createOffsetRange(
                                        document,
                                        lineStartOffset + rhsStart,
                                        lineStartOffset + rhsStart + rhs.length,
                                        docLength
                                    )
                                    : createOffsetRange(
                                        document,
                                        lineStartOffset,
                                        lineStartOffset + Math.max(1, lineText.length),
                                        docLength
                                    ),
                                t('validation.arrayMustBeIndexed', { name: issue.name })
                            )
                        );
                    }
                }
            }
        }

        if (hasMutationOperator) {
            const mutationSourceLine = String(strippedLineText || '');
            const normalizedMutationLine = mayHaveInlineStatementPrefix(mutationSourceLine)
                ? stripLeadingInlineStatementPrefix(mutationSourceLine)
                : { text: mutationSourceLine, startOffset: 0 };
            const mutation = parseStandaloneMutationStatement(normalizedMutationLine.text);
            if (mutation?.target) {
                const targetLooksAssignable = isSyntacticAssignableExpression(mutation.target);
                const analysisCache = targetLooksAssignable ? getDeclarationAnalysisCache() : null;
                const analysisDecls = analysisCache ? [] : ctx.allDecls;
                const assignable = targetLooksAssignable
                    ? getExpressionAssignableInfo(mutation.target, analysisDecls, analysisCache, { escapeChar })
                    : null;
                if (!targetLooksAssignable || assignable?.isConst) {
                    const targetStart = lineText.indexOf(
                        mutation.target,
                        normalizedMutationLine.startOffset + mutation.start
                    );
                    if (targetStart >= 0) {
                        diagnostics.push(
                            createLiveValidationDiagnostic(
                                assignable?.isConst
                                    ? createTargetNameRange(mutation.target, targetStart, assignable)
                                    : createOffsetRange(
                                        document,
                                        lineStartOffset + targetStart,
                                        lineStartOffset + targetStart + mutation.target.length,
                                        docLength
                                    ),
                                assignable?.isConst
                                    ? getConstMutationMessage(assignable, mutation.target)
                                    : t('validation.mustBeLValue')
                            )
                        );
                    }
                }
            }
        }

        for (const decl of currentVariableDecls) {
            if (decl?.type !== 'variable' || decl.dims || !decl.value) continue;
            const analysisCache = getDeclarationAnalysisCache();
            const analysisDecls = analysisCache ? [] : ctx.allDecls;
            const valueText = String(decl.value || '').trim();
            const issue = findArrayMustBeIndexedIssue(decl.value, analysisDecls, analysisCache, { escapeChar });
            if (!issue) {
                const actualType = inferArgType(valueText, analysisDecls, analysisCache);
                if (!actualType?.dims) continue;
                const valueIndex = valueText ? lineText.indexOf(valueText) : -1;
                diagnostics.push(
                    createLiveValidationDiagnostic(
                        valueIndex >= 0
                            ? createOffsetRange(
                                document,
                                lineStartOffset + valueIndex,
                                lineStartOffset + valueIndex + valueText.length,
                                docLength
                            )
                            : createOffsetRange(
                                document,
                                lineStartOffset,
                                lineStartOffset + Math.max(1, lineText.length),
                                docLength
                            ),
                        t('validation.mustBeAssignedToArray')
                    )
                );
                continue;
            }
            const valueIndex = valueText ? lineText.indexOf(valueText) : -1;
            diagnostics.push(
                createLiveValidationDiagnostic(
                    valueIndex >= 0
                        ? createOffsetRange(
                            document,
                            lineStartOffset + valueIndex,
                            lineStartOffset + valueIndex + valueText.length,
                            docLength
                        )
                        : createOffsetRange(
                            document,
                            lineStartOffset,
                            lineStartOffset + Math.max(1, lineText.length),
                            docLength
                        ),
                    t('validation.arrayMustBeIndexed', { name: issue.name })
                )
            );
        }
        for (const decl of currentVariableDecls) {
            if (!decl?.dims) continue;
            const analysisCache = getDeclarationAnalysisCache();
            const analysisDecls = analysisCache ? [] : ctx.allDecls;
            const invalidArraySizeIssue = findInvalidArraySizeIssue(decl, analysisDecls, analysisCache);
            if (invalidArraySizeIssue) {
                const dimStart = lineText.indexOf(invalidArraySizeIssue.dimText);
                const message = invalidArraySizeIssue.kind === 'tooManyDimensions'
                    ? t('validation.exceedingMaximumNumberOfDimensions')
                    : t('validation.invalidArraySize');
                diagnostics.push(
                    createLiveValidationDiagnostic(
                        dimStart >= 0
                            ? createOffsetRange(
                                document,
                                lineStartOffset + dimStart,
                                lineStartOffset + dimStart + invalidArraySizeIssue.dimText.length,
                                docLength
                            )
                            : createOffsetRange(
                                document,
                                lineStartOffset,
                                lineStartOffset + Math.max(1, lineText.length),
                                docLength
                            ),
                        message
                    )
                );
                continue;
            }
            const initializerIssue = explainArrayInitializerIssue(decl, analysisDecls, escapeChar, analysisCache);
            if (!initializerIssue) continue;
            if (
                initializerIssue.kind === 'partial' &&
                (
                    isOpenMultilineBraceInitializerForCurrentDecl(trimmedLine, currentVariableDecls, lineNumber) ||
                    isOpenMultilineBraceInitializerLine(trimmedLine)
                )
            ) {
                continue;
            }
            const valueText = String(decl.value || '').trim();
            const valueIndex = valueText ? lineText.indexOf(valueText) : -1;
            const isEnumInitializerWarning =
                initializerIssue.kind === 'enumFieldCountOverflow' ||
                initializerIssue.kind === 'enumFieldInitializerOverflow';
            if (isEnumInitializerWarning && !areWarningDiagnosticsEnabled()) continue;
            const message = initializerIssue.kind === 'overflow'
                ? t('validation.initializationDataExceedsDeclaredSize')
                : (initializerIssue.kind === 'enumFieldCountOverflow'
                    ? t('validation.moreInitializersThanEnumFields')
                    : (initializerIssue.kind === 'enumFieldInitializerOverflow'
                        ? t('validation.enumFieldInitializerTooLong')
                        : (initializerIssue.kind === 'constantRequired'
                            ? t('validation.mustBeConstantExpression')
                            : t('validation.multidimArrayMustBeFullyInitialized'))));
            diagnostics.push(
                createLiveValidationDiagnostic(
                    valueIndex >= 0
                        ? createOffsetRange(
                            document,
                            lineStartOffset + valueIndex,
                            lineStartOffset + valueIndex + Math.max(1, valueText.length),
                            docLength
                        )
                        : createOffsetRange(
                            document,
                            lineStartOffset,
                            lineStartOffset + Math.max(1, lineText.length),
                            docLength
                        ),
                    message,
                    isEnumInitializerWarning ? getWarningSeverity() : undefined
                )
            );
        }

        return diagnostics;
    }

    return {
        collectDeclarationLiveDiagnosticsForLine
    };
}

module.exports = { createDeclarationDiagnostics };
