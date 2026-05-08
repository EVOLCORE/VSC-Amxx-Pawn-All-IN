function createHoverCallPlanFeature(deps) {
    const {
        t,
        lookup,
        functions,
        incDecls,
        funcArgs,
        parseFuncArgs,
        hasIncludeFunctionTwin,
        getPreferredFunctionHoverMatch,
        getDeclMatchKey,
        resolveArgumentSymbolName,
        applyHoverDisplayNameSuffixToMatches,
        createHoverRangeFromOffsets
    } = deps;

    const pushUniqueMatch = (matches, label, data, nav) => {
        if (!data) return;
        const key = `${getDeclMatchKey(data)}|${label}`;
        if (!matches.some(match => `${getDeclMatchKey(match.data)}|${match.label}` === key)) {
            matches.push({ label, data, nav });
        }
    };

    const resolveCallArgHoverMatches = ({
        shouldShowArgHoverInfo = false,
        definitionCtx = null,
        nestedFunctionArgCtx = null,
        activeSignatureCtx = null,
        signatureData = null,
        signatureArgLayout = null,
        targetFunc = '',
        argIndex = null,
        callSiteArgs = null,
        word = '',
        wordAccessSuffix = ''
    }) => {
        const argHoverMatches = [];
        if (shouldShowArgHoverInfo && definitionCtx && argIndex != null) {
            let argDecl = null;
            let argDeclNav = false;
            if (signatureData && hasIncludeFunctionTwin(targetFunc, incDecls, lookup)) {
                const includeArgDecls = parseFuncArgs(
                    signatureData.args || '',
                    signatureData.filePath,
                    signatureData.file,
                    signatureData.lineNumber
                );
                argDecl = includeArgDecls[argIndex] || null;
                argDeclNav = !!argDecl?.filePath;
            } else {
                argDecl = funcArgs[argIndex] || null;
            }
            if (argDecl) {
                argHoverMatches.push({
                    label: t('hover.kind.argument'),
                    data: argDecl,
                    nav: argDeclNav
                });
            }
        } else if (shouldShowArgHoverInfo && nestedFunctionArgCtx) {
            const preferredNestedFunctionArg = getPreferredFunctionHoverMatch(
                nestedFunctionArgCtx.child.funcName,
                functions,
                incDecls,
                {},
                lookup
            );
            if (preferredNestedFunctionArg) {
                argHoverMatches.push(preferredNestedFunctionArg);
            }
        } else if (shouldShowArgHoverInfo && activeSignatureCtx) {
            const argSymbolName = resolveArgumentSymbolName(
                word,
                signatureArgLayout?.currentRawArgExpr ??
                    signatureArgLayout?.currentArgExpr ??
                    callSiteArgs?.[activeSignatureCtx.argIndex],
                activeSignatureCtx.funcName
            );
            if (argSymbolName) {
                const fa = lookup.findFuncArg(argSymbolName);
                const lo = lookup.findLocal(argSymbolName);
                const gl = lookup.findGlobal(argSymbolName);
                const ff = lookup.findFunction(argSymbolName);
                const ii = lookup.filterIncludes(
                    argSymbolName,
                    d => d.type === 'variable' || d.type === 'enum-item' || d.type === 'define'
                );
                const bb = lookup.filterBuiltins(argSymbolName);
                const preferredFunctionArg = getPreferredFunctionHoverMatch(
                    argSymbolName,
                    functions,
                    incDecls,
                    {},
                    lookup
                );

                pushUniqueMatch(argHoverMatches, t('hover.kind.argument'), fa, false);
                pushUniqueMatch(argHoverMatches, t('hover.kind.local'), lo, true);
                pushUniqueMatch(argHoverMatches, t('hover.kind.global'), gl, true);
                for (const d of ii) {
                    pushUniqueMatch(argHoverMatches, t('hover.kind.include'), d, true);
                }
                for (const d of bb) {
                    pushUniqueMatch(argHoverMatches, t('hover.kind.compiler'), d, false);
                }
                if (preferredFunctionArg) {
                    pushUniqueMatch(
                        argHoverMatches,
                        preferredFunctionArg.label,
                        preferredFunctionArg.data,
                        preferredFunctionArg.nav
                    );
                } else {
                    pushUniqueMatch(argHoverMatches, t('hover.kind.function'), ff, true);
                }
            }
        }

        applyHoverDisplayNameSuffixToMatches(argHoverMatches, word, wordAccessSuffix);
        return argHoverMatches;
    };

    const resolveSemanticCallHoverPlan = ({
        shouldShowArgHoverInfo = false,
        definitionCtx = null,
        nestedFunctionArgCtx = null,
        activeSignatureCtx = null,
        signatureData = null,
        signatureArgLayout = null,
        targetFunc = '',
        argIndex = null,
        callSiteArgs = null,
        documentSemanticKey = '',
        word = '',
        wordAccessSuffix = '',
        indexedAccessHoverCtx = null,
        tokenRange = null
    }) => {
        const argHoverMatches = resolveCallArgHoverMatches({
            shouldShowArgHoverInfo,
            definitionCtx,
            nestedFunctionArgCtx,
            activeSignatureCtx,
            signatureData,
            signatureArgLayout,
            targetFunc,
            argIndex,
            callSiteArgs,
            word,
            wordAccessSuffix
        });
        const effectiveArgIndex = definitionCtx
            ? argIndex
            : (activeSignatureCtx && targetFunc === activeSignatureCtx.funcName)
                ? argIndex
                : null;
        const validateSignatureArgs = !definitionCtx ||
            hasIncludeFunctionTwin(targetFunc, incDecls, lookup);
        const forceColoredSignature = !!(
            !definitionCtx &&
            signatureData &&
            activeSignatureCtx &&
            targetFunc === activeSignatureCtx.funcName
        );
        const semanticCallHoverCacheKey = activeSignatureCtx && targetFunc === activeSignatureCtx.funcName
            ? [
                'call',
                documentSemanticKey,
                targetFunc,
                activeSignatureCtx.openOffset,
                activeSignatureCtx.closeOffset ?? -1,
                effectiveArgIndex ?? -1,
                word || '',
                wordAccessSuffix || '',
                indexedAccessHoverCtx?.suffix || '',
                indexedAccessHoverCtx?.activeAccessIndex ?? -1
            ].join('|')
            : '';
        const semanticHoverRange =
            (definitionCtx
                ? createHoverRangeFromOffsets(
                    definitionCtx.openOffset,
                    definitionCtx.closeOffset != null ? definitionCtx.closeOffset + 1 : definitionCtx.openOffset + 1
                )
                : null) ||
            (activeSignatureCtx
                ? createHoverRangeFromOffsets(
                    activeSignatureCtx.openOffset,
                    activeSignatureCtx.closeOffset != null ? activeSignatureCtx.closeOffset + 1 : activeSignatureCtx.openOffset + 1
                )
                : null) ||
            tokenRange;

        return {
            argHoverMatches,
            effectiveArgIndex,
            validateSignatureArgs,
            forceColoredSignature,
            semanticCallHoverCacheKey,
            semanticHoverRange
        };
    };

    return {
        resolveCallArgHoverMatches,
        resolveSemanticCallHoverPlan
    };
}

module.exports = { createHoverCallPlanFeature };
