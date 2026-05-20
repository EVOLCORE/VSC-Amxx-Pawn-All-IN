const { createTagOverridePolicySyntaxCore } = require('../../core/syntax/tag-override-policy');
const { hasUncontinuedPhysicalLineBreakBetweenOffsets } = require('../../core/syntax/macro-call-policy');
const { getTypeAnalysisSourceDecls } = require('../../core/validation/type-analysis-cache');
const { isPotentialEnumDeclarationLine } = require('../../core/declarations/line-utils');

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
        isEscapedQuote,
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
    const tagOverridePolicyRuntime = createTagOverridePolicySyntaxCore({
        isEscapedQuote,
        isIdentifierStartChar,
        isIdentifierContinueChar
    });

    function collectCallLiveDiagnostics(document, ctx, callCtx, analysisCache, docLength, callLineNumber = null) {
        const diagnostics = [];
        if (isIncludeDocument(document) && !isStrictIncludeValidationEnabled()) return diagnostics;
        if (!callCtx?.funcName) return diagnostics;
        const warningsEnabled = areWarningDiagnosticsEnabled();
        const callLine = Number.isInteger(callLineNumber)
            ? callLineNumber
            : document.positionAt(callCtx.openOffset).line;
        if (isPotentialEnumDeclarationLine((ctx.strippedLines || ctx.rawLines || [])[callLine] || '')) {
            return diagnostics;
        }
        if (isFunctionDefinitionHeaderCall(ctx, callCtx.funcName, callLine)) {
            return diagnostics;
        }

        const findCallNameOffsets = () => {
            if (
                Number.isInteger(callCtx.nameStartOffset) &&
                Number.isInteger(callCtx.nameEndOffset) &&
                callCtx.nameStartOffset >= 0 &&
                callCtx.nameStartOffset < callCtx.nameEndOffset
            ) {
                return {
                    startOffset: callCtx.nameStartOffset,
                    endOffset: callCtx.nameEndOffset
                };
            }
            let cursor = Math.max(0, callCtx.openOffset - 1);
            while (cursor >= 0 && /\s/.test(ctx.text[cursor])) cursor--;
            const endOffset = cursor + 1;
            while (cursor >= 0 && isIdentifierContinueChar(ctx.text[cursor])) cursor--;
            return { startOffset: cursor + 1, endOffset };
        };

        const createWholeCallRange = () => {
            const { startOffset } = findCallNameOffsets();
            const closeOffset = Number.isInteger(callCtx.closeOffset)
                ? callCtx.closeOffset
                : findMatchingParenOffset(ctx.text, callCtx.openOffset, ctx.text.length, ctx.resolver);
            const endOffset = closeOffset >= 0 ? closeOffset + 1 : callCtx.openOffset + 1;
            return createOffsetRange(document, startOffset, endOffset, docLength);
        };

        const createCallNameRange = () => {
            const { startOffset, endOffset } = findCallNameOffsets();
            return createOffsetRange(document, startOffset, endOffset, docLength);
        };

        const findCallResultTagOverride = () => {
            const nameOffsets = findCallNameOffsets();
            return tagOverridePolicyRuntime.findTagOverrideBeforeIdentifier(
                ctx.text,
                nameOffsets,
                callCtx.funcName,
                {
                    getEscapeCharAtOffset: offset => ctx.resolver?.ctrlCharAtOffset?.(offset)
                }
            );
        };

        const collectCallResultTagOverrideDiagnostic = signatureData => {
            if (!warningsEnabled) return null;
            if (typeof explainTypeCompat !== 'function') return null;
            const tagOverride = findCallResultTagOverride();
            if (!tagOverride) return null;
            const expectedTag = signatureData.typeTag || '';
            const expectedDims = signatureData.dims || '';
            if (!expectedTag && !expectedDims) return null;
            const expectedParam = `${expectedTag ? `${expectedTag}:` : ''}__return${expectedDims}`;
            const syntheticTaggedValue = `${tagOverride.tag}:0`;
            const analysisDecls = ctx.allDecls;
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
        const deprecatedIssue = warningsEnabled
            ? getDeprecatedSymbolIssue(signatureData)
            : null;
        if (deprecatedIssue) {
            diagnostics.push(createLiveValidationDiagnostic(
                createCallNameRange(),
                t(deprecatedIssue.messageKey, deprecatedIssue.params || {}),
                getWarningSeverity()
            ));
        }
        const closeOffset = Number.isInteger(callCtx.closeOffset)
            ? callCtx.closeOffset
            : findMatchingParenOffset(ctx.text, callCtx.openOffset, ctx.text.length, ctx.resolver);
        if (closeOffset < 0) return diagnostics;

        const resultTagDiagnostic = collectCallResultTagOverrideDiagnostic(signatureData);
        if (resultTagDiagnostic) diagnostics.push(resultTagDiagnostic);
        if (isFunctionLikeDefineDecl(signatureData)) {
            if (
                hasUncontinuedPhysicalLineBreakBetweenOffsets(
                    ctx.rawLines || [],
                    ctx.lineStartOffsets || null,
                    callCtx.openOffset,
                    closeOffset
                )
            ) {
                diagnostics.push(createLiveValidationDiagnostic(
                    createCallNameRange(),
                    t('validation.functionLikeDefineCallMustStayOnOneLine')
                ));
            }
            return diagnostics;
        }

        const rawArgText = ctx.text.slice(callCtx.openOffset + 1, closeOffset);
        const callEscapeChar = ctx.resolver.ctrlCharAtOffset(callCtx.openOffset);
        if (
            (rawArgText.includes('"') || rawArgText.includes("'")) &&
            hasLineBreakInsideStringLiteral(rawArgText, callEscapeChar)
        ) {
            return diagnostics;
        }
        if (!String(signatureData.args || '').trim() && !rawArgText.trim()) {
            return diagnostics;
        }
        const rawArgPieces = splitTopLevelWithRanges(
            rawArgText,
            callCtx.openOffset + 1,
            callEscapeChar
        );
        let expandedPieces = rawArgPieces;
        const analysisDecls = getTypeAnalysisSourceDecls(ctx, analysisCache);
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
            includeWarnings: warningsEnabled,
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
