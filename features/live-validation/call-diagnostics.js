const { createTagOverridePolicySyntaxCore } = require('../../core/syntax/tag-override-policy');
const { hasUncontinuedPhysicalLineBreakBetweenOffsets } = require('../../core/syntax/macro-call-policy');
const { getTypeAnalysisSourceDecls } = require('../../core/validation/type-analysis-cache');
const { isPotentialEnumDeclarationLine } = require('../../core/declarations/line-utils');
const {
    collectFormatArgumentLinksForArgumentPieces,
    hasFormatPlaceholderSyntaxCandidate
} = require('../../core/format-strings');
const {
    LIVE_FORMAT_PLACEHOLDER_DIAGNOSTIC_CODE
} = require('./diagnostic-codes');

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
        parsePawnExpression,
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

        let cachedCallNameOffsets = null;
        const findCallNameOffsets = () => {
            if (cachedCallNameOffsets) return cachedCallNameOffsets;
            if (
                Number.isInteger(callCtx.nameStartOffset) &&
                Number.isInteger(callCtx.nameEndOffset) &&
                callCtx.nameStartOffset >= 0 &&
                callCtx.nameStartOffset < callCtx.nameEndOffset
            ) {
                cachedCallNameOffsets = {
                    startOffset: callCtx.nameStartOffset,
                    endOffset: callCtx.nameEndOffset
                };
                return cachedCallNameOffsets;
            }
            let cursor = Math.max(0, callCtx.openOffset - 1);
            while (cursor >= 0 && /\s/.test(ctx.text[cursor])) cursor--;
            const endOffset = cursor + 1;
            while (cursor >= 0 && isIdentifierContinueChar(ctx.text[cursor])) cursor--;
            cachedCallNameOffsets = { startOffset: cursor + 1, endOffset };
            return cachedCallNameOffsets;
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
        const readMalformedArgumentToken = (source, index) => {
            const text = String(source || '');
            if (!text) return { token: '', startIndex: 0, length: 1 };
            const safeIndex = Math.max(0, Math.min(text.length - 1, index | 0));
            const remainder = text.slice(safeIndex);
            const token = remainder.match(/^[^\s,\])};]+/)?.[0] || text[safeIndex] || '';
            return {
                token: token || '',
                startIndex: safeIndex,
                length: Math.max(1, token.length || 0)
            };
        };
        const getMalformedCallArgumentDiagnostic = rawArgPiece => {
            if (!rawArgPiece || typeof parsePawnExpression !== 'function') return null;
            const rawText = String(rawArgPiece.text || '');
            const trimmed = rawText.trim();
            if (!trimmed) return null;

            let exprText = trimmed;
            let exprOffsetDelta = rawText.indexOf(trimmed);
            if (trimmed[0] === '.') {
                const eqIndex = trimmed.indexOf('=');
                if (eqIndex <= 1) return null;
                const valueText = trimmed.slice(eqIndex + 1);
                const valueTrimmed = valueText.trim();
                if (!valueTrimmed) return null;
                exprText = valueTrimmed;
                exprOffsetDelta += eqIndex + 1 + valueText.indexOf(valueTrimmed);
            }

            const parsed = parsePawnExpression(exprText, { escapeChar: callEscapeChar });
            if (parsed?.ok || parsed?.kind === 'empty') return null;
            const malformedToken = readMalformedArgumentToken(exprText, parsed?.index ?? 0);
            const startOffset = rawArgPiece.startOffset + exprOffsetDelta + malformedToken.startIndex;
            const endOffset = startOffset + malformedToken.length;
            return createLiveValidationDiagnostic(
                createOffsetRange(document, startOffset, endOffset, docLength),
                t('validation.unexpectedToken', { token: malformedToken.token || '' })
            );
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
            const expectedTag = signatureData.typeTag || '';
            const expectedDims = signatureData.dims || '';
            if (!expectedTag && !expectedDims) return null;
            const tagOverride = findCallResultTagOverride();
            if (!tagOverride) return null;
            const expectedParam = `${expectedTag ? `${expectedTag}:` : ''}__return${expectedDims}`;
            const syntheticTaggedValue = `${tagOverride.tag}:0`;
            const analysisDecls = getTypeAnalysisSourceDecls(ctx, analysisCache);
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
        const mayHaveFormatPlaceholders = layout.variadicIndex >= 0 &&
            hasFormatPlaceholderSyntaxCandidate(rawArgText);
        if (mayHaveFormatPlaceholders) {
            for (const link of collectFormatArgumentLinksForArgumentPieces(ctx.text, expandedPieces, {
                isEscapedQuote,
                escapeChar: callEscapeChar,
                callName: callCtx.funcName,
                maxFormatArgIndexExclusive: layout.variadicIndex
            })) {
                const expectedCount = Math.max(0, link?.placeholder?.consumes | 0);
                const actualCount = Array.isArray(link?.args) ? link.args.length : 0;
                if (!expectedCount || actualCount >= expectedCount) continue;
                const diagnostic = createLiveValidationDiagnostic(
                    createOffsetRange(document, link.placeholder.startOffset, link.placeholder.endOffset, docLength),
                    t('validation.formatPlaceholderMissingArgument', {
                        placeholder: link.placeholder.raw || '',
                        expected: expectedCount,
                        actual: actualCount
                    })
                );
                diagnostic.code = LIVE_FORMAT_PLACEHOLDER_DIAGNOSTIC_CODE;
                diagnostics.push(diagnostic);
            }
        }
        const malformedRawArgIndexes = new Set();
        for (let rawArgIndex = 0; rawArgIndex < rawArgPieces.length; rawArgIndex++) {
            const malformedDiagnostic = getMalformedCallArgumentDiagnostic(rawArgPieces[rawArgIndex]);
            if (!malformedDiagnostic) continue;
            malformedRawArgIndexes.add(rawArgIndex);
            diagnostics.push(malformedDiagnostic);
        }
        const issuePlan = collectCallArgumentIssues(signatureData.args || '', callSiteArgs, analysisDecls, analysisCache, {
            includeWarnings: warningsEnabled,
            includeMissingArguments: true,
            callEscapeChar,
            precomputedLayout: layout,
            allowBareRationalLiteralTypeCascades: !!ctx.preprocessedState?.rationalState
        });
        const plannedIssues = malformedRawArgIndexes.size
            ? (issuePlan.issues || []).filter(issue => {
                if (malformedRawArgIndexes.has(issue.rawArgIndex)) return false;
                if (issue.kind === 'missingArgument' || issue.kind === 'extraArgument') return false;
                return true;
            })
            : (issuePlan.issues || []);
        for (const issue of plannedIssues) {
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
