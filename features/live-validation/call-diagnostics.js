function createCallDiagnostics(deps) {
    const {
        areWarningDiagnosticsEnabled,
        buildCallArgLayout,
        collectCallArgumentIssues,
        createLiveValidationDiagnostic,
        createOffsetRange,
        explainTypeCompat,
        expandObjectLikeDefineTupleArgPieces,
        findMatchingParenOffset,
        getCallArgumentIssueRange,
        getDeprecatedSymbolIssue,
        getResolvedCallSignatureData,
        getTypeCompatSeverity,
        getWarningSeverity,
        hasExpandableObjectLikeDefineTupleArg,
        hasLineBreakInsideStringLiteral,
        isFunctionDefinitionHeaderCall,
        isFunctionLikeDecl,
        isFunctionLikeDefineDecl,
        isIdentifierContinueChar,
        isIdentifierStartChar,
        isIncludeDocument,
        isStrictIncludeValidationEnabled,
        splitTopLevelWithRanges,
        t
    } = deps;

    function collectCallLiveDiagnostics(document, ctx, callCtx, analysisCache, docLength, callLineNumber = null) {
        const diagnostics = [];
        if (isIncludeDocument(document) && !isStrictIncludeValidationEnabled()) return diagnostics;
        if (!callCtx?.funcName) return diagnostics;
        const callLine = Number.isInteger(callLineNumber)
            ? callLineNumber
            : document.positionAt(callCtx.openOffset).line;
        if (isFunctionDefinitionHeaderCall(ctx, callCtx.funcName, callLine)) {
            return diagnostics;
        }

        const createWholeCallRange = () => {
            let cursor = Math.max(0, callCtx.openOffset - 1);
            while (cursor >= 0 && /\s/.test(ctx.text[cursor])) cursor--;
            while (cursor >= 0 && isIdentifierContinueChar(ctx.text[cursor])) cursor--;
            const startOffset = cursor + 1;
            const closeOffset = Number.isInteger(callCtx.closeOffset)
                ? callCtx.closeOffset
                : findMatchingParenOffset(ctx.text, callCtx.openOffset, ctx.text.length, ctx.resolver);
            const endOffset = closeOffset >= 0 ? closeOffset + 1 : callCtx.openOffset + 1;
            return createOffsetRange(document, startOffset, endOffset, docLength);
        };

        const findCallNameOffsets = () => {
            let cursor = Math.max(0, callCtx.openOffset - 1);
            while (cursor >= 0 && /\s/.test(ctx.text[cursor])) cursor--;
            const endOffset = cursor + 1;
            while (cursor >= 0 && isIdentifierContinueChar(ctx.text[cursor])) cursor--;
            return { startOffset: cursor + 1, endOffset };
        };

        const createCallNameRange = () => {
            const { startOffset, endOffset } = findCallNameOffsets();
            return createOffsetRange(document, startOffset, endOffset, docLength);
        };

        const findCallResultTagOverride = () => {
            if (typeof isIdentifierStartChar !== 'function') return null;
            const nameOffsets = findCallNameOffsets();
            if (ctx.text.slice(nameOffsets.startOffset, nameOffsets.endOffset) !== callCtx.funcName) return null;
            let colonOffset = nameOffsets.startOffset - 1;
            while (colonOffset >= 0 && (ctx.text[colonOffset] === ' ' || ctx.text[colonOffset] === '\t')) {
                colonOffset--;
            }
            if (ctx.text[colonOffset] !== ':') return null;
            if (ctx.text[colonOffset - 1] === ':' || ctx.text[colonOffset + 1] === ':') return null;

            let cursor = colonOffset - 1;
            while (cursor >= 0 && (ctx.text[cursor] === ' ' || ctx.text[cursor] === '\t')) cursor--;
            const tagEndOffset = cursor + 1;
            while (cursor >= 0 && isIdentifierContinueChar(ctx.text[cursor])) cursor--;
            const tagStartOffset = cursor + 1;
            if (tagStartOffset >= tagEndOffset) return null;
            if (!isIdentifierStartChar(ctx.text[tagStartOffset] || '')) return null;

            return {
                tag: ctx.text.slice(tagStartOffset, tagEndOffset),
                startOffset: tagStartOffset,
                endOffset: colonOffset + 1
            };
        };

        const collectCallResultTagOverrideDiagnostic = signatureData => {
            if (!areWarningDiagnosticsEnabled()) return null;
            if (typeof explainTypeCompat !== 'function') return null;
            const tagOverride = findCallResultTagOverride();
            if (!tagOverride) return null;
            const expectedTag = signatureData.typeTag || '';
            const expectedDims = signatureData.dims || '';
            const expectedParam = `${expectedTag ? `${expectedTag}:` : ''}__return${expectedDims}`;
            const syntheticTaggedValue = `${tagOverride.tag}:0`;
            const analysisDecls = analysisCache ? [] : ctx.allDecls;
            const compat = explainTypeCompat(
                expectedParam,
                tagOverride.tag,
                expectedDims,
                syntheticTaggedValue,
                analysisDecls,
                { analysisCache }
            );
            if (!compat?.reason || compat.status === 'ok') return null;
            return createLiveValidationDiagnostic(
                createOffsetRange(document, tagOverride.startOffset, tagOverride.endOffset, docLength),
                compat.reason,
                getTypeCompatSeverity(compat.status)
            );
        };

        const signatureData = getResolvedCallSignatureData(callCtx.funcName, ctx, analysisCache);
        if (!signatureData || !isFunctionLikeDecl(signatureData)) {
            const knownNonFunctionDecl = ctx.lookup.findAnyDeclByName(callCtx.funcName);
            diagnostics.push(
                createLiveValidationDiagnostic(
                    createWholeCallRange(),
                    knownNonFunctionDecl
                        ? t('validation.invalidFunctionCall')
                        : t('validation.unknownSymbol', { symbols: callCtx.funcName })
                )
            );
            return diagnostics;
        }
        const deprecatedIssue = areWarningDiagnosticsEnabled()
            ? getDeprecatedSymbolIssue(signatureData)
            : null;
        if (deprecatedIssue) {
            diagnostics.push(createLiveValidationDiagnostic(
                createCallNameRange(),
                t(deprecatedIssue.messageKey, deprecatedIssue.params || {}),
                getWarningSeverity()
            ));
        }
        const resultTagDiagnostic = collectCallResultTagOverrideDiagnostic(signatureData);
        if (resultTagDiagnostic) diagnostics.push(resultTagDiagnostic);
        if (isFunctionLikeDefineDecl(signatureData)) return diagnostics;

        const closeOffset = Number.isInteger(callCtx.closeOffset)
            ? callCtx.closeOffset
            : findMatchingParenOffset(ctx.text, callCtx.openOffset, ctx.text.length, ctx.resolver);
        if (closeOffset < 0) return diagnostics;

        const rawArgText = ctx.text.slice(callCtx.openOffset + 1, closeOffset);
        const callEscapeChar = ctx.resolver.ctrlCharAtOffset(callCtx.openOffset);
        if (hasLineBreakInsideStringLiteral(rawArgText, callEscapeChar)) return diagnostics;
        const rawArgPieces = splitTopLevelWithRanges(
            rawArgText,
            callCtx.openOffset + 1,
            callEscapeChar
        );
        let expandedPieces = rawArgPieces;
        const analysisDecls = analysisCache ? [] : ctx.allDecls;
        let callSiteArgs = rawArgPieces.map(item => item.text);
        let layout = buildCallArgLayout(signatureData.args || '', callSiteArgs, null, {
            useDynamicCache: false
        });
        if (
            rawArgPieces.length < layout.params.length &&
            hasExpandableObjectLikeDefineTupleArg(rawArgPieces, analysisCache, callEscapeChar)
        ) {
            const expandedArgs = expandObjectLikeDefineTupleArgPieces(
                rawArgPieces,
                analysisCache,
                callEscapeChar
            );
            expandedPieces = expandedArgs.expandedPieces || rawArgPieces;
            callSiteArgs = expandedPieces.map(item => item.text);
            layout = buildCallArgLayout(signatureData.args || '', callSiteArgs, null, {
                useDynamicCache: false
            });
        }
        const issuePlan = collectCallArgumentIssues(signatureData.args || '', callSiteArgs, analysisDecls, analysisCache, {
            includeWarnings: areWarningDiagnosticsEnabled(),
            includeMissingArguments: true,
            callEscapeChar,
            precomputedLayout: layout,
            allowBareRationalLiteralTypeCascades: !!ctx.preprocessedState?.rationalState
        });
        for (const issue of issuePlan.issues || []) {
            const rawArgIndex = Number.isInteger(issue.rawArgIndex) ? issue.rawArgIndex : -1;
            const rawArgPiece = rawArgIndex >= 0 && expandedPieces[rawArgIndex]
                ? expandedPieces[rawArgIndex]
                : null;
            const defaultRange = rawArgPiece
                ? createOffsetRange(document, rawArgPiece.startOffset, rawArgPiece.endOffset, docLength)
                : createOffsetRange(document, callCtx.openOffset, closeOffset + 1, docLength);
            const range = rawArgPiece
                ? getCallArgumentIssueRange(
                    document,
                    rawArgPiece,
                    issue.actualExpr,
                    issue.paramMeta,
                    ctx,
                    analysisDecls,
                    analysisCache,
                    docLength,
                    issue.kind
                ) || defaultRange
                : defaultRange;
            diagnostics.push(createLiveValidationDiagnostic(
                range,
                issue.reason,
                getTypeCompatSeverity(issue.status)
            ));
        }

        return diagnostics;
    }

    return {
        collectCallLiveDiagnostics
    };
}

module.exports = { createCallDiagnostics };
