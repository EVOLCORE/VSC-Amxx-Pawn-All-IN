function createHeaderDiagnostics(deps) {
    const {
        areWarningDiagnosticsEnabled,
        collectDefaultParamLiveDiagnostics,
        collectOperatorOverloadPolicyIssues,
        compareFunctionDeclarationsByPrototype,
        compareFunctionReturnByPrototype,
        createLiveValidationDiagnostic,
        createOffsetRange,
        explainParamDeclCompat,
        findMatchingParenOffset,
        getCallbackSignatureMode,
        getHeaderParamMeta,
        getOldStylePrototypeIssue,
        getPreferredFunctionHoverMatch,
        getSymbolTruncationIssue,
        getVariableShadowingIssue,
        getWarningSeverity,
        hasIncludeFunctionTwin,
        parseFunctionStateSpecFromHeaderText,
        collectFunctionStateIssues,
        areStatefulFunctionRedeclarationsAllowed,
        isFunctionLikeAliasWrapperDefine,
        isIncludeDocument,
        isOperatorOverloadName,
        splitTopLevel,
        splitTopLevelWithRanges,
        t,
        vscode
    } = deps;

    function collectHeaderLiveDiagnostics(document, ctx, functionDecl, analysisCache, docLength) {
        const diagnostics = [];
        if (!functionDecl?.name) {
            return diagnostics;
        }

        const previousLocalDecls = (ctx.parsedDecls.functions || []).filter(item =>
            item !== functionDecl &&
            item.name === functionDecl.name &&
            (item.startLine ?? item.lineNumber ?? 0) < (functionDecl.startLine ?? functionDecl.lineNumber ?? 0)
        );

        const lineStartOffsets = ctx.lineStartOffsets || null;
        const startOffset = lineStartOffsets?.[functionDecl.startLine] ??
            document.offsetAt(new vscode.Position(functionDecl.startLine, 0));
        const endLine = functionDecl.headerEndLine ?? functionDecl.startLine;
        const endLineText = (ctx.rawLines || [])[endLine] ?? document.lineAt(endLine).text;
        const endOffset = (lineStartOffsets?.[endLine] ?? document.offsetAt(new vscode.Position(endLine, 0))) + endLineText.length;
        const segment = ctx.text.slice(startOffset, endOffset);
        const nameIndex = segment.indexOf(functionDecl.name);
        if (nameIndex < 0) return diagnostics;
        const openRelative = segment.indexOf('(', nameIndex + functionDecl.name.length);
        if (openRelative < 0) return diagnostics;
        const pushHeaderWarning = (range, issue) => {
            if (!issue || !areWarningDiagnosticsEnabled()) return;
            diagnostics.push(createLiveValidationDiagnostic(
                range,
                t(issue.messageKey, issue.params || {}),
                getWarningSeverity()
            ));
        };
        const nameRange = createOffsetRange(
            document,
            startOffset + nameIndex,
            startOffset + nameIndex + functionDecl.name.length,
            docLength
        );
        pushHeaderWarning(
            nameRange,
            getSymbolTruncationIssue(functionDecl.name)
        );
        pushHeaderWarning(
            createOffsetRange(document, startOffset + nameIndex, endOffset, docLength),
            getOldStylePrototypeIssue(functionDecl, segment)
        );
        const openOffset = startOffset + openRelative;
        const closeOffset = findMatchingParenOffset(ctx.text, openOffset, endOffset, ctx.resolver);
        if (closeOffset < 0) return diagnostics;
        const stateSpecFromHeader = parseFunctionStateSpecFromHeaderText(segment);

        const localArgPieces = splitTopLevelWithRanges(
            ctx.text.slice(openOffset + 1, closeOffset),
            openOffset + 1,
            ctx.resolver.ctrlCharAtOffset(openOffset)
        );
        const localArgs = localArgPieces.map(item => item.text);
        const analysisDecls = analysisCache ? [] : ctx.allDecls;

        const buildHeaderMismatchDiagnostic = message => {
            const range = localArgPieces[0]
                ? createOffsetRange(document, localArgPieces[0].startOffset, localArgPieces[localArgPieces.length - 1].endOffset, docLength)
                : createOffsetRange(document, openOffset, closeOffset + 1, docLength);
            diagnostics.push(createLiveValidationDiagnostic(range, message));
        };
        if (
            (functionDecl.name === 'main' || functionDecl.name === 'entry') &&
            localArgPieces.length > 0
        ) {
            buildHeaderMismatchDiagnostic(t('validation.functionMayNotHaveArguments'));
        }

        for (const diagnostic of collectDefaultParamLiveDiagnostics(
            document,
            functionDecl,
            localArgPieces,
            analysisCache,
            docLength
        )) {
            diagnostics.push(diagnostic);
        }
        const seenParamNames = new Set();
        for (const piece of localArgPieces) {
            const meta = getHeaderParamMeta(piece?.text || '', analysisCache);
            const name = meta?.name || '';
            if (!name) continue;
            if (seenParamNames.has(name)) {
                diagnostics.push(createLiveValidationDiagnostic(
                    createOffsetRange(document, piece.startOffset, piece.endOffset, docLength),
                    t('validation.symbolAlreadyDefined', { name })
                ));
                continue;
            }
            seenParamNames.add(name);
            const shadowedGlobal = (ctx.parsedDecls?.globals || []).find(item =>
                item?.name === name &&
                item.lineNumber < (functionDecl.startLine ?? functionDecl.lineNumber ?? 0)
            ) || null;
            pushHeaderWarning(
                createOffsetRange(document, piece.startOffset, piece.endOffset, docLength),
                getVariableShadowingIssue({ name, type: 'variable' }, shadowedGlobal)
            );
        }

        const pushOperatorPolicyDiagnostic = (issue, message) => {
            const piece = Number.isInteger(issue?.paramIndex) && issue.paramIndex >= 0
                ? localArgPieces[issue.paramIndex]
                : null;
            diagnostics.push(createLiveValidationDiagnostic(
                piece
                    ? createOffsetRange(document, piece.startOffset, piece.endOffset, docLength)
                    : createOffsetRange(document, openOffset, closeOffset + 1, docLength),
                message
            ));
        };
        for (const issue of collectOperatorOverloadPolicyIssues(functionDecl, localArgs, analysisCache)) {
            switch (issue.kind) {
                case 'operatorCannotBeRedefined':
                    pushOperatorPolicyDiagnostic(issue, t('validation.operatorCannotBeRedefined'));
                    break;
                case 'operatorArgumentMayOnlyHaveSingleTag':
                    pushOperatorPolicyDiagnostic(
                        issue,
                        t('validation.operatorArgumentMayOnlyHaveSingleTag', { index: issue.argumentIndex || 0 })
                    );
                    break;
                case 'operatorArgumentMustBeArray':
                    pushOperatorPolicyDiagnostic(
                        issue,
                        t('validation.functionArgumentMustBeArray', { name: issue.name || '' })
                    );
                    break;
                case 'operatorArgumentMayNotBeReferenceOrArray':
                    pushOperatorPolicyDiagnostic(
                        issue,
                        t('validation.functionArgumentMayNotBeReferenceOrArray', { name: issue.name || '' })
                    );
                    break;
                case 'operatorOperandCountMismatch':
                    pushOperatorPolicyDiagnostic(issue, t('validation.operatorOperandCountMismatch'));
                    break;
                case 'cannotChangePredefinedOperators':
                    pushOperatorPolicyDiagnostic(issue, t('validation.cannotChangePredefinedOperators'));
                    break;
                case 'operatorResultTagMismatch':
                    pushOperatorPolicyDiagnostic(
                        issue,
                        t('validation.operatorResultTagMismatch', {
                            operator: issue.token || '',
                            tag: issue.expectedTag || ''
                        })
                    );
                    break;
            }
        }

        const pushStateIssueDiagnostic = issue => {
            const relativeStart = stateSpecFromHeader
                ? stateSpecFromHeader.start
                : (Number.isInteger(issue?.rangeStart) ? issue.rangeStart : openRelative);
            const relativeEnd = stateSpecFromHeader
                ? stateSpecFromHeader.end
                : (Number.isInteger(issue?.rangeEnd) ? issue.rangeEnd : (closeOffset - startOffset + 1));
            const severity = issue?.severity === 'warning'
                ? vscode.DiagnosticSeverity.Warning
                : vscode.DiagnosticSeverity.Error;
            diagnostics.push(createLiveValidationDiagnostic(
                createOffsetRange(document, startOffset + relativeStart, startOffset + relativeEnd, docLength),
                t(issue.messageKey, issue.params || {}),
                severity
            ));
        };
        for (const issue of collectFunctionStateIssues(functionDecl, ctx.parsedDecls?.functions || [])) {
            pushStateIssueDiagnostic(issue);
        }

        const includeDecl = hasIncludeFunctionTwin(functionDecl.name, ctx.incDecls, ctx.lookup)
            ? (getPreferredFunctionHoverMatch(
                functionDecl.name,
                ctx.parsedDecls.functions,
                ctx.incDecls,
                { preferInclude: true },
                ctx.lookup
            )?.data || null)
            : null;
        const shouldSkipCompilerLikePublicForwardSignatureCheck = parentDecl =>
            getCallbackSignatureMode() === 'compiler-like' &&
            functionDecl?.type === 'public' &&
            parentDecl?.type === 'forward';
        const shouldValidateIncludeTwin =
            !!includeDecl &&
            !shouldSkipCompilerLikePublicForwardSignatureCheck(includeDecl);
        if (shouldValidateIncludeTwin) {
            if (!compareFunctionReturnByPrototype(includeDecl, functionDecl, ctx, analysisCache)) {
                buildHeaderMismatchDiagnostic(t('validation.functionHeadingDiffersFromPrototype'));
            }
            const includeArgs = splitTopLevel(includeDecl.args || '');

            const isPublicForwardCallback =
                functionDecl?.type === 'public' && includeDecl?.type === 'forward';
            const argLimit = isPublicForwardCallback
                ? Math.min(includeArgs.length, localArgs.length)
                : Math.max(includeArgs.length, localArgs.length);
            for (let index = 0; index < argLimit; index++) {
                const expectedParam = includeArgs[index];
                const actualParam = localArgs[index];
                let message = '';

                if (!expectedParam && actualParam) {
                    message = t('validation.extraParameter');
                } else if (expectedParam && !actualParam) {
                    message = t('validation.missingParameterDeclaration');
                } else if (expectedParam && actualParam) {
                    const result = explainParamDeclCompat(expectedParam, actualParam, analysisDecls, { analysisCache });
                    if (result.status === 'error') message = result.reason;
                }

                if (!message) continue;
                const range = localArgPieces[index]
                    ? createOffsetRange(document, localArgPieces[index].startOffset, localArgPieces[index].endOffset, docLength)
                    : createOffsetRange(document, openOffset, closeOffset + 1, docLength);
                diagnostics.push(createLiveValidationDiagnostic(range, message));
            }
        }

        const previousPrototype = isOperatorOverloadName(functionDecl.name)
            ? (previousLocalDecls.find(item =>
                compareFunctionDeclarationsByPrototype(item, functionDecl, ctx, analysisCache)
            ) || null)
            : (previousLocalDecls[previousLocalDecls.length - 1] || null);
        if (previousPrototype) {
            const isAliasWrapperRedeclaration =
                isIncludeDocument(document) &&
                isFunctionLikeAliasWrapperDefine(functionDecl) &&
                previousPrototype.type !== 'define';
            const isForwardLike = previousPrototype.type === 'forward' || previousPrototype.type === 'native';
            if (isForwardLike) {
                if (
                    !shouldSkipCompilerLikePublicForwardSignatureCheck(previousPrototype) &&
                    !compareFunctionDeclarationsByPrototype(previousPrototype, functionDecl, ctx, analysisCache)
                ) {
                    buildHeaderMismatchDiagnostic(t('validation.functionHeadingDiffersFromPrototype'));
                }
            } else if (
                !isAliasWrapperRedeclaration &&
                !areStatefulFunctionRedeclarationsAllowed(previousPrototype, functionDecl) &&
                previousPrototype.type !== 'define' &&
                functionDecl.type !== 'forward' &&
                functionDecl.type !== 'native'
            ) {
                buildHeaderMismatchDiagnostic(
                    t('validation.symbolAlreadyDefined', { name: functionDecl.name })
                );
            }
        }

        return diagnostics;
    }

    return {
        collectHeaderLiveDiagnostics
    };
}

module.exports = { createHeaderDiagnostics };
