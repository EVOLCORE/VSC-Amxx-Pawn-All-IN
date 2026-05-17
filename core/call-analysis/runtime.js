// Shared call-analysis helpers used by hover and live validation.
// Extracted behind dependency injection so we can keep behavior stable while
// gradually shrinking the main extension file.
const { createCallArgLayoutCore } = require('./arg-layout');
const { createPawnFunctionCallRegex } = require('../declarations/line-utils');
const { getPawnIdentifierName } = require('../syntax/identifiers');
const { buildLineStartOffsets } = require('../syntax/lines');

function createCallAnalysisCore(deps) {
    const {
        vscode,
        t,
        escapeRegExp,
        isIdentifierStartChar,
        isIdentifierContinueChar,
        parseParamMeta,
        isVariadicParam,
        inferArgType,
        inferArrayShapeActualType,
        getExpressionAssignableInfo,
        findArrayMustBeIndexedIssue,
        explainTypeCompat,
        explainParamDeclCompat,
        getArrayShapeIssue,
        explainArrayShapeDiagnosticIssue,
        isEscapedQuote,
        FORBIDDEN,
        withCtrlCharForContent,
        getActiveCtrlChar,
        splitTopLevel,
        splitTopLevelWithRanges,
        isFunctionLikeDecl,
        getDocumentTextAndResolver,
        isKnownFunctionName,
        collectRationalLiteralIssues
    } = deps;
    const {
        buildCallArgLayout,
        expandObjectLikeDefineTupleArgPieces,
        expandObjectLikeDefineTupleCallArgs,
        getObjectLikeDefineTupleTexts,
        hasExpandableObjectLikeDefineTupleArg
    } = createCallArgLayoutCore({
        parseParamMeta,
        isVariadicParam,
        getActiveCtrlChar,
        splitTopLevel,
        splitTopLevelWithRanges
    });

    function getWordAtPosition(document, position) {
        const range = document.getWordRangeAtPosition(position);
        return range ? document.getText(range) : null;
    }

    function collectCallArgumentIssues(paramsOrArgsText, rawCallSiteArgs, allDecls = [], analysisCache = null, options = {}) {
        const {
            rawCurrentArgIndex = null,
            validationMode = 'call',
            isMacroDefine = false,
            includeWarnings = true,
            includeMissingArguments = true,
            callEscapeChar = getActiveCtrlChar(),
            precomputedLayout = null,
            allowBareRationalLiteralTypeCascades = true
        } = options;
        const layout = precomputedLayout || buildCallArgLayout(paramsOrArgsText, rawCallSiteArgs, rawCurrentArgIndex);
        const params = layout.params || [];
        const paramMetas = layout.paramMetas || [];
        const variadicIndex = layout.variadicIndex;
        const isVariadic = variadicIndex >= 0;
        const issues = [];
        const unknownNamedArgRawIndexes = new Set();
        const shouldPushStatus = status => status === 'error' || (status === 'warn' && includeWarnings);
        const pushIssue = issue => {
            if (!issue?.reason || !shouldPushStatus(issue.status || 'error')) return;
            issues.push({
                status: 'error',
                ...issue
            });
        };

        if (!isMacroDefine) {
            for (const issue of layout.namedArgIssues || []) {
                if (issue.kind === 'unknownNamedArgument') {
                    unknownNamedArgRawIndexes.add(issue.rawIndex);
                    pushIssue({
                        kind: 'unknownNamedArgument',
                        status: 'error',
                        rawArgIndex: issue.rawIndex,
                        actualExpr: issue.argText || issue.name || '',
                        paramText: issue.argText || issue.name || '',
                        reason: t('validation.unknownSymbol', { symbols: issue.name || '' })
                    });
                    continue;
                }
                pushIssue({
                    kind: issue.kind,
                    status: 'error',
                    rawArgIndex: issue.rawIndex,
                    actualExpr: issue.argText || '',
                    paramText: issue.argText || '',
                    reason: issue.kind === 'duplicateNamedArgument'
                        ? t('validation.duplicateNamedArgument')
                        : t('validation.positionalAfterNamedArgument')
                });
            }
        }

        const getParamMeta = index => paramMetas[index] || analysisCache?.getParamMeta?.(params[index]) || parseParamMeta(params[index]);
        const getActualType = actualExpr => inferArgType(actualExpr, allDecls, analysisCache);
        const getShapeActualType = actualExpr => {
            return inferArrayShapeActualType(actualExpr, allDecls, analysisCache);
        };
        const getCallArrayShapeIssueReason = shapeIssue => {
            if (!shapeIssue) return '';
            return explainArrayShapeDiagnosticIssue(shapeIssue).reason;
        };
        const hasRationalLiteralDiagnostic = source =>
            collectRationalLiteralIssues(source, null).length > 0;
        const isRedundantBareRationalLiteralTypeIssue = issue => {
            if (allowBareRationalLiteralTypeCascades) return false;
            if (issue?.kind !== 'typeCompat') return false;
            if (!issue.paramMeta?.expectedDims) return false;
            const actualExpr = String(issue.actualExpr || '').trim();
            if (!actualExpr.startsWith('{')) return false;
            return hasRationalLiteralDiagnostic(actualExpr);
        };
        const pushCallArgumentIssue = issue => {
            if (isRedundantBareRationalLiteralTypeIssue(issue)) return;
            pushIssue(issue);
        };
        const explainByRefArgumentIssue = (actualExpr, paramMeta, index) => {
            if (!paramMeta) return null;
            const expectedDims = paramMeta.expectedDims || '';
            const isReferenceLike = !!paramMeta.isByRef || !!expectedDims;
            if (!isReferenceLike) return null;
            const actualSource = String(actualExpr || '').trim();
            if (actualSource === '_') return null;

            const assignable = getExpressionAssignableInfo(actualExpr, allDecls, analysisCache, {
                escapeChar: callEscapeChar
            });
            if (paramMeta.isByRef && !expectedDims) {
                if (!assignable?.isLValue || assignable.dims) {
                    return {
                        status: 'error',
                        reason: t('validation.argumentTypeMismatch', { index: index + 1 })
                    };
                }
                if (assignable.isConst && !paramMeta.isConst) {
                    return {
                        status: 'error',
                        reason: t('validation.argumentTypeMismatch', { index: index + 1 })
                    };
                }
            }

            if (
                expectedDims &&
                assignable?.isConst &&
                !paramMeta.isConst &&
                !(assignable.isIndexedAccess && assignable.dims)
            ) {
                return {
                    status: 'error',
                    reason: t('validation.argumentTypeMismatch', { index: index + 1 })
                };
            }

            return null;
        };

        for (let index = 0; index < params.length; index++) {
            if (isVariadic && index === variadicIndex) continue;
            const paramText = params[index] || '';
            const paramMeta = getParamMeta(index);
            const actualExpr = layout.effectiveArgs[index];
            const rawArgIndex = layout.firstRawIndexByParamIndex?.[index] ?? -1;
            if (rawArgIndex < 0 && unknownNamedArgRawIndexes.size) continue;
            const hasActualArg = actualExpr !== undefined;
            if (isMacroDefine) continue;

            if (!hasActualArg) {
                if (includeMissingArguments && !paramMeta.hasDefault) {
                    pushIssue({
                        kind: 'missingArgument',
                        status: 'error',
                        paramIndex: index,
                        rawArgIndex,
                        paramText: paramText.trim(),
                        actualExpr: '',
                        paramMeta,
                        reason: t('validation.missingArgument')
                    });
                }
                continue;
            }

            if (validationMode === 'declaration') {
                const result = explainParamDeclCompat(paramText, actualExpr, allDecls, { analysisCache });
                pushIssue({
                    kind: 'declarationCompat',
                    status: result.status,
                    paramIndex: index,
                    rawArgIndex,
                    paramText: paramText.trim(),
                    actualExpr,
                    paramMeta,
                    reason: result.reason
                });
                continue;
            }

            const byRefIssue = rawArgIndex >= 0
                ? explainByRefArgumentIssue(actualExpr, paramMeta, index)
                : null;
            if (byRefIssue) {
                pushIssue({
                    kind: 'byRefArgumentMismatch',
                    status: byRefIssue.status || 'error',
                    paramIndex: index,
                    rawArgIndex,
                    paramText: paramText.trim(),
                    actualExpr,
                    paramMeta,
                    reason: byRefIssue.reason
                });
                continue;
            }

            if (!paramMeta.expectedDims) {
                const arrayIssue = findArrayMustBeIndexedIssue(actualExpr, allDecls, analysisCache, {
                    escapeChar: callEscapeChar
                });
                if (arrayIssue) {
                    pushIssue({
                        kind: 'arrayMustBeIndexed',
                        status: arrayIssue.status || 'error',
                        paramIndex: index,
                        rawArgIndex,
                        paramText: paramText.trim(),
                        actualExpr,
                        paramMeta,
                        reason: arrayIssue.reason || t('validation.arrayMustBeIndexed', { name: arrayIssue.name || '' })
                    });
                    continue;
                }
            }

            if (paramMeta.expectedDims) {
                const shapeActual = getShapeActualType(actualExpr);
                const shapeIssue = getArrayShapeIssue(
                    paramMeta.expectedDims,
                    shapeActual?.type?.dims || '',
                    actualExpr,
                    allDecls,
                    analysisCache,
                    { escapeChar: callEscapeChar }
                );
                if (
                    shapeIssue &&
                    (
                        shapeIssue.kind === 'indexTag' ||
                        shapeIssue.kind === 'size'
                    )
                ) {
                    const reason = getCallArrayShapeIssueReason(shapeIssue);
                    pushIssue({
                        kind: 'arrayShape',
                        status: shapeIssue.status || 'error',
                        paramIndex: index,
                        rawArgIndex,
                        paramText: paramText.trim(),
                        actualExpr,
                        paramMeta,
                        shapeIssue,
                        reason
                    });
                    continue;
                }
            }

            const actual = getActualType(actualExpr);
            const result = explainTypeCompat(paramText, actual.tag, actual.dims, actualExpr, allDecls, {
                paramMeta,
                analysisCache
            });
            pushCallArgumentIssue({
                kind: 'typeCompat',
                status: result.status,
                paramIndex: index,
                rawArgIndex,
                paramText: paramText.trim(),
                actualExpr,
                paramMeta,
                reason: result.reason
            });
        }

        if (!isMacroDefine && isVariadic && variadicIndex >= 0) {
            const variadicParam = params[variadicIndex] || '';
            const variadicMeta = getParamMeta(variadicIndex);
            for (let rawIndex = 0; rawIndex < (rawCallSiteArgs?.length || 0); rawIndex++) {
                if (layout.rawToParamIndex[rawIndex] !== variadicIndex) continue;
                if (unknownNamedArgRawIndexes.has(rawIndex)) continue;
                const actualExpr = String(rawCallSiteArgs?.[rawIndex] || '').trim();
                if (!actualExpr) continue;
                const result = actualExpr === '_'
                    ? { status: 'error', reason: t('validation.argumentCountMismatch') }
                    : (() => {
                        const actual = getActualType(actualExpr);
                        return explainTypeCompat(
                            variadicParam,
                            actual.tag,
                            actual.dims,
                            actualExpr,
                            allDecls,
                            {
                                paramMeta: variadicMeta,
                                analysisCache,
                                allowArrayToScalar: true
                            }
                        );
                    })();
                pushIssue({
                    kind: 'variadicTypeCompat',
                    status: result.status,
                    paramIndex: variadicIndex,
                    rawArgIndex: rawIndex,
                    paramText: variadicParam.trim(),
                    actualExpr,
                    paramMeta: variadicMeta,
                    reason: result.reason
                });
            }
        }

        if (!isMacroDefine && !isVariadic) {
            for (let rawIndex = 0; rawIndex < (rawCallSiteArgs?.length || 0); rawIndex++) {
                if (unknownNamedArgRawIndexes.has(rawIndex)) continue;
                if (layout.rawToParamIndex[rawIndex] != null) continue;
                const actualExpr = String(rawCallSiteArgs?.[rawIndex] || 'arg').trim() || 'arg';
                pushIssue({
                    kind: 'extraArgument',
                    status: 'error',
                    rawArgIndex: rawIndex,
                    paramIndex: params.length + issues.length,
                    paramText: actualExpr,
                    actualExpr,
                    reason: t('validation.extraArgument')
                });
            }
        }

        return { layout, issues };
    }

    function getCallNameInfoBeforeIndex(text, endIndex) {
        let cursor = endIndex - 1;
        while (cursor >= 0 && /\s/.test(text[cursor])) cursor--;
        if (cursor < 0 || !isIdentifierContinueChar(text[cursor])) return null;

        const end = cursor + 1;
        while (cursor >= 0 && isIdentifierContinueChar(text[cursor])) cursor--;
        const start = cursor + 1;
        const firstChar = text[start] || '';
        if (!isIdentifierStartChar(firstChar)) return null;

        const funcName = text.slice(start, end);
        return FORBIDDEN.has(funcName)
            ? null
            : {
                funcName,
                nameStartOffset: start,
                nameEndOffset: end
            };
    }

    function getCallNameBeforeIndex(text, endIndex) {
        return getCallNameInfoBeforeIndex(text, endIndex)?.funcName || null;
    }

    function cloneCallStack(callStack = []) {
        return (callStack || []).map(ctx => ({ ...ctx }));
    }

    function scanCallContextSegment(text, startOffset, endOffset, state, resolver = null, closeOffsetByOpen = null) {
        let index = Math.max(0, startOffset);
        const limit = Math.max(index, Math.min(String(text || '').length, endOffset));
        const callStack = state.callStack || [];
        let inStr = !!state.inStr;
        let strChar = state.strChar || '';
        let lineComment = !!state.lineComment;
        let blockComment = !!state.blockComment;

        while (index < limit) {
            const c = text[index];

            if (blockComment) {
                if (c === '*' && text[index + 1] === '/' && index + 1 < limit) {
                    blockComment = false;
                    index += 2;
                } else {
                    index++;
                }
                continue;
            }
            if (lineComment) {
                if (c === '\n') lineComment = false;
                index++;
                continue;
            }
            if (inStr) {
                const escapeChar = resolver?.ctrlCharAtOffset?.(index) || getActiveCtrlChar();
                if (c === strChar && !isEscapedQuote(text, index, escapeChar)) inStr = false;
                index++;
                continue;
            }

            if (c === '/' && text[index + 1] === '/' && index + 1 < limit) {
                lineComment = true;
                index += 2;
                continue;
            }
            if (c === '/' && text[index + 1] === '*' && index + 1 < limit) {
                blockComment = true;
                index += 2;
                continue;
            }
            if (c === '"' || c === "'") {
                inStr = true;
                strChar = c;
                index++;
                continue;
            }
            if (c === '(') {
                const callNameInfo = getCallNameInfoBeforeIndex(text, index);
                callStack.push({
                    funcName: callNameInfo?.funcName || null,
                    nameStartOffset: callNameInfo ? callNameInfo.nameStartOffset : -1,
                    nameEndOffset: callNameInfo ? callNameInfo.nameEndOffset : -1,
                    openOffset: index,
                    argIndex: 0
                });
            } else if (c === ')') {
                if (callStack.length > 0) {
                    const closedCall = callStack.pop();
                    if (closeOffsetByOpen && Number.isInteger(closedCall?.openOffset)) {
                        closeOffsetByOpen.set(closedCall.openOffset, index);
                    }
                }
            } else if (c === ',' && callStack.length > 0) {
                callStack[callStack.length - 1].argIndex++;
            }

            index++;
        }

        state.inStr = inStr;
        state.strChar = strChar;
        state.lineComment = lineComment;
        state.blockComment = blockComment;
        state.callStack = callStack;
        return state;
    }

    function createDocumentCallContextIndex(document, sharedLineStartOffsets = null) {
        const { text, resolver } = getDocumentTextAndResolver(document);
        const source = String(text || '');
        const expectedLineCount = Number.isInteger(document?.lineCount) ? document.lineCount : 0;
        const hasFreshSharedLineOffsets =
            Array.isArray(sharedLineStartOffsets) &&
            sharedLineStartOffsets.length &&
            sharedLineStartOffsets[0] === 0 &&
            sharedLineStartOffsets[sharedLineStartOffsets.length - 1] <= source.length &&
            (!expectedLineCount || sharedLineStartOffsets.length === expectedLineCount);
        let lineStartOffsets = hasFreshSharedLineOffsets
            ? sharedLineStartOffsets
            : null;
        if (!lineStartOffsets) {
            lineStartOffsets = buildLineStartOffsets(source);
        }

        const lineStartSnapshots = new Array(lineStartOffsets.length);
        const closeOffsetByOpen = new Map();
        const emptyLineStartSnapshot = {
            callStack: [],
            inStr: false,
            strChar: '',
            lineComment: false,
            blockComment: false
        };
        const scanState = {
            callStack: [],
            inStr: false,
            strChar: '',
            lineComment: false,
            blockComment: false
        };
        let scannedThroughLine = -1;

        const getLineNumberAtOffset = offset => {
            const boundedOffset = Math.max(0, Math.min(source.length, offset || 0));
            let low = 0;
            let high = lineStartOffsets.length - 1;
            while (low <= high) {
                const mid = (low + high) >> 1;
                const lineStart = lineStartOffsets[mid];
                const nextLineStart = lineStartOffsets[mid + 1] ?? (source.length + 1);
                if (boundedOffset < lineStart) {
                    high = mid - 1;
                } else if (boundedOffset >= nextLineStart) {
                    low = mid + 1;
                } else {
                    return mid;
                }
            }
            return Math.max(0, lineStartOffsets.length - 1);
        };

        const ensureScannedThroughLine = (targetLine, stopWhen = null) => {
            const boundedTargetLine = Math.max(0, Math.min(lineStartOffsets.length - 1, targetLine || 0));
            while (scannedThroughLine < boundedTargetLine) {
                const line = scannedThroughLine + 1;
                lineStartSnapshots[line] = (
                    scanState.callStack.length === 0 &&
                    !scanState.inStr &&
                    !scanState.strChar &&
                    !scanState.blockComment
                )
                    ? emptyLineStartSnapshot
                    : {
                        callStack: cloneCallStack(scanState.callStack),
                        inStr: scanState.inStr,
                        strChar: scanState.strChar,
                        lineComment: false,
                        blockComment: scanState.blockComment
                    };
                const startOffset = lineStartOffsets[line];
                const endOffset = lineStartOffsets[line + 1] ?? source.length;
                scanCallContextSegment(source, startOffset, endOffset, scanState, resolver, closeOffsetByOpen);
                scanState.lineComment = false;
                scannedThroughLine = line;
                if (typeof stopWhen === 'function' && stopWhen()) {
                    break;
                }
            }
        };

        const getLineSnapshot = lineNumber => {
            const boundedLine = Math.max(0, Math.min(lineStartSnapshots.length - 1, lineNumber || 0));
            ensureScannedThroughLine(boundedLine);
            const snapshot = lineStartSnapshots[boundedLine] || {
                callStack: [],
                inStr: false,
                strChar: '',
                lineComment: false,
                blockComment: false
            };
            return {
                line: boundedLine,
                lineStartOffset: lineStartOffsets[boundedLine] ?? 0,
                state: {
                    callStack: cloneCallStack(snapshot.callStack),
                    inStr: snapshot.inStr,
                    strChar: snapshot.strChar,
                    lineComment: false,
                    blockComment: snapshot.blockComment
                }
            };
        };

        const findKnownMatchingParenOffset = (openParenOffset, maxOffset = source.length) => {
            const existingCloseOffset = closeOffsetByOpen.get(openParenOffset);
            const boundedMaxOffset = Math.max(0, Math.min(source.length, maxOffset || 0));
            if (Number.isInteger(existingCloseOffset) && existingCloseOffset < boundedMaxOffset) {
                return existingCloseOffset;
            }
            const targetLine = getLineNumberAtOffset(boundedMaxOffset);
            ensureScannedThroughLine(targetLine, () => closeOffsetByOpen.has(openParenOffset));
            const closeOffset = closeOffsetByOpen.get(openParenOffset);
            return Number.isInteger(closeOffset) && closeOffset < boundedMaxOffset
                ? closeOffset
                : -1;
        };

        return {
            text: source,
            lineStartOffsets,
            closeOffsetByOpen,
            findCallContexts(position) {
                const { lineStartOffset, state: queryState } = getLineSnapshot(position?.line || 0);
                const cursorOffset = document.offsetAt(position);
                scanCallContextSegment(
                    source,
                    lineStartOffset,
                    Math.max(lineStartOffset, cursorOffset),
                    queryState,
                    resolver,
                    null
                );
                return queryState.callStack.filter(ctx => ctx.funcName);
            },
            findCallContext(position) {
                const contexts = this.findCallContexts(position);
                return contexts.length ? contexts[contexts.length - 1] : null;
            },
            findMatchingParenOffset(openParenOffset, maxOffset = source.length) {
                return findKnownMatchingParenOffset(openParenOffset, maxOffset);
            }
        };
    }

    function createLazyCallContextOptions(document, semanticSession = null) {
        const options = {};
        Object.defineProperty(options, 'callContextIndex', {
            enumerable: true,
            configurable: true,
            get() {
                if (semanticSession?.callContextIndex) {
                    return semanticSession.callContextIndex;
                }
                const index = createDocumentCallContextIndex(document, semanticSession?.lineStartOffsets || null);
                if (semanticSession) {
                    if (!semanticSession.lineStartOffsets) {
                        semanticSession.lineStartOffsets = index.lineStartOffsets;
                    }
                    semanticSession.callContextIndex = index;
                }
                return index;
            }
        });
        return options;
    }

    function getCallContextIndex(options = {}) {
        return options?.callContextIndex || null;
    }

    const EMPTY_CALL_CONTEXTS = [];

    function collectInlineNamedCallContexts(linePrefix, lineStartOffset, escapeChar, options = {}) {
        const includeClosedCalls = options.includeClosedCalls === true;
        const callStack = [];
        const completedCalls = [];
        let index = 0;
        let inStr = false, strChar = '', lineComment = false, blockComment = false;

        while (index < linePrefix.length) {
            const c = linePrefix[index];

            if (blockComment) {
                if (c === '*' && linePrefix[index + 1] === '/') { blockComment = false; index += 2; }
                else index++;
                continue;
            }
            if (lineComment) break;
            if (inStr) {
                if (c === strChar && !isEscapedQuote(linePrefix, index, escapeChar)) inStr = false;
                index++;
                continue;
            }

            if (c === '/' && linePrefix[index + 1] === '/') { lineComment = true; index += 2; continue; }
            if (c === '/' && linePrefix[index + 1] === '*') { blockComment = true; index += 2; continue; }
            if (c === '"' || c === "'") { inStr = true; strChar = c; index++; continue; }

            if (c === '(') {
                const callNameInfo = getCallNameInfoBeforeIndex(linePrefix, index);
                callStack.push({
                    funcName: callNameInfo?.funcName || null,
                    nameStartOffset: callNameInfo ? lineStartOffset + callNameInfo.nameStartOffset : -1,
                    nameEndOffset: callNameInfo ? lineStartOffset + callNameInfo.nameEndOffset : -1,
                    openOffset: lineStartOffset + index,
                    argIndex: 0
                });
            } else if (c === ')') {
                if (callStack.length > 0) {
                    const closedCall = callStack.pop();
                    if (includeClosedCalls && closedCall?.funcName) {
                        completedCalls.push({
                            ...closedCall,
                            closeOffset: lineStartOffset + index
                        });
                    }
                }
            } else if (c === ',' && callStack.length > 0) {
                callStack[callStack.length - 1].argIndex++;
            }

            index++;
        }

        const activeCalls = callStack.filter(ctx => ctx.funcName);
        if (!activeCalls.length) {
            return includeClosedCalls
                ? (completedCalls.length ? completedCalls : EMPTY_CALL_CONTEXTS)
                : EMPTY_CALL_CONTEXTS;
        }
        return includeClosedCalls
            ? (completedCalls.length ? [...completedCalls, ...activeCalls] : activeCalls)
            : activeCalls;
    }

    function extractCallSiteArgs(text, openParenOffset) {
        return withCtrlCharForContent(text, () => {
            let d = 0, inStr = false, strChar = '';
            let end = openParenOffset;
            for (let i = openParenOffset; i < text.length; i++) {
                const c = text[i];
                if (inStr) { if (c === strChar && !isEscapedQuote(text, i)) inStr = false; continue; }
                if (c === '"' || c === "'") { inStr = true; strChar = c; continue; }
                if (c === '(') d++;
                else if (c === ')') { d--; if (d === 0) { end = i; break; } }
            }
            return splitTopLevel(text.slice(openParenOffset + 1, end), getActiveCtrlChar(), true);
        });
    }

    function findMatchingParenOffset(text, openParenOffset, maxOffset = text.length, ctrlCharResolver = null, options = {}) {
        const callContextIndex = getCallContextIndex(options);
        if (callContextIndex?.findMatchingParenOffset) {
            return callContextIndex.findMatchingParenOffset(openParenOffset, maxOffset);
        }
        return withCtrlCharForContent(text, () => {
            let d = 0, inStr = false, strChar = '';
            for (let i = openParenOffset; i < Math.min(text.length, maxOffset); i++) {
                const c = text[i];
                if (inStr) {
                    const escapeChar = ctrlCharResolver?.ctrlCharAtOffset(i) || getActiveCtrlChar();
                    if (c === strChar && !isEscapedQuote(text, i, escapeChar)) inStr = false;
                    continue;
                }
                if (c === '"' || c === "'") { inStr = true; strChar = c; continue; }
                if (c === '(') d++;
                else if (c === ')') {
                    d--;
                    if (d === 0) return i;
                }
            }
            return -1;
        });
    }

    function isWithinMeaningfulCallArgument(text, cursorOffset, callCtx, ctrlCharResolver = null, options = {}) {
        if (!callCtx || !Number.isInteger(callCtx.openOffset)) return false;
        const closeOffset = findMatchingParenOffset(text, callCtx.openOffset, text.length, ctrlCharResolver, options);
        if (closeOffset < 0 || cursorOffset <= callCtx.openOffset || cursorOffset >= closeOffset) {
            return false;
        }

        let depth = 0;
        let inStr = false;
        let strCh = '';
        let segmentStart = callCtx.openOffset + 1;
        for (let index = callCtx.openOffset + 1; index <= closeOffset; index++) {
            const c = index < closeOffset ? text[index] : ')';
            if (depth === 0 && index === closeOffset) {
                if (cursorOffset >= segmentStart && cursorOffset < index) {
                    return !!String(text.slice(segmentStart, index)).trim();
                }
                break;
            }
            if (inStr) {
                const escapeChar = ctrlCharResolver?.ctrlCharAtOffset(index) || getActiveCtrlChar();
                if (c === strCh && !isEscapedQuote(text, index, escapeChar)) inStr = false;
                continue;
            }
            if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
                continue;
            }
            if ('[({'.includes(c)) {
                depth++;
                continue;
            }
            if ('])}'.includes(c)) {
                depth = Math.max(0, depth - 1);
                continue;
            }
            if (depth === 0 && c === ',') {
                if (cursorOffset >= segmentStart && cursorOffset < index) {
                    return !!String(text.slice(segmentStart, index)).trim();
                }
                segmentStart = index + 1;
            }
        }

        return false;
    }

    function getPreferredFunctionHoverMatch(name, functions, incDecls, options = {}, lookup = null) {
        if (!name) return null;
        if (lookup?.getPreferredFunctionMatch) {
            return lookup.getPreferredFunctionMatch(name, options);
        }

        const preferInclude = !!options.preferInclude;
        const visitedAliases = options.aliasVisited instanceof Set ? options.aliasVisited : new Set();
        const getAliasTargetName = decl => {
            if (!decl || decl.type !== 'define' || decl.args || decl.macroStyle) return '';
            const targetName = getPawnIdentifierName(decl.value);
            return targetName && targetName !== decl.name ? targetName : '';
        };
        const createAliasMatch = (match, aliasDefine, aliasName, immediateTargetName) => {
            if (!match?.data || !aliasDefine || !aliasName) return match;
            const targetDecl = match.data.aliasTargetDecl || match.data;
            const targetName = targetDecl.name || match.data.aliasTargetName || immediateTargetName || '';
            return {
                ...match,
                data: {
                    ...targetDecl,
                    hoverDisplayName: aliasName,
                    aliasName,
                    aliasTargetName: targetName,
                    aliasImmediateTargetName: immediateTargetName || targetName,
                    aliasDefineDecl: aliasDefine,
                    aliasTargetDecl: targetDecl
                }
            };
        };

        const localFunc = functions.find(d => d.name === name);
        const includeCandidates = (incDecls || []).filter(d => d.name === name && isFunctionLikeDecl(d));
        const includeFunc = includeCandidates.reduce(
            (best, candidate) =>
                !best || (candidate.lineNumber ?? -1) > (best.lineNumber ?? -1) ? candidate : best,
            null
        );

        if (preferInclude) {
            if (includeFunc) {
                return { label: t('hover.kind.include'), data: includeFunc, nav: true };
            }
            if (localFunc) {
                return { label: t('hover.kind.function'), data: localFunc, nav: true };
            }
            return null;
        }

        if (localFunc) {
            return { label: t('hover.kind.function'), data: localFunc, nav: true };
        }

        if (includeFunc) {
            return { label: t('hover.kind.include'), data: includeFunc, nav: true };
        }

        if (!visitedAliases.has(name)) {
            visitedAliases.add(name);
            const aliasDefine = [
                ...(functions || []),
                ...(incDecls || [])
            ].find(d => d.name === name && getAliasTargetName(d));
            const targetName = getAliasTargetName(aliasDefine);
            if (targetName && !visitedAliases.has(targetName)) {
                const targetMatch = getPreferredFunctionHoverMatch(
                    targetName,
                    functions,
                    incDecls,
                    { ...options, aliasVisited: visitedAliases },
                    null
                );
                if (targetMatch) return createAliasMatch(targetMatch, aliasDefine, name, targetName);
            }
        }

        return null;
    }

    function findCallContext(document, position, options = {}) {
        const contexts = findCallContexts(document, position, options);
        return contexts.length ? contexts[contexts.length - 1] : null;
    }

    function findCallContexts(document, position, options = {}) {
        const callContextIndex = getCallContextIndex(options);
        if (callContextIndex?.findCallContexts) {
            return callContextIndex.findCallContexts(position);
        }
        const { text, resolver } = getDocumentTextAndResolver(document);
        const cursorOffset = document.offsetAt(position);
        const state = {
            callStack: [],
            inStr: false,
            strChar: '',
            lineComment: false,
            blockComment: false
        };
        scanCallContextSegment(text, 0, cursorOffset, state, resolver, null);
        return state.callStack.filter(ctx => ctx.funcName);
    }

    function findInlineCallContext(document, position) {
        const { text, resolver } = getDocumentTextAndResolver(document);
        return withCtrlCharForContent(text, () => {
            const lineText = document.lineAt(position.line).text;
            const limit = Math.min(position.character, lineText.length);
            const linePrefix = lineText.slice(0, limit);
            const lineStartOffset = document.offsetAt(new vscode.Position(position.line, 0));
            const escapeChar = resolver.ctrlCharAtLine(position.line);
            const callStack = collectInlineNamedCallContexts(linePrefix, lineStartOffset, escapeChar);
            for (let i = callStack.length - 1; i >= 0; i--) {
                if (callStack[i].funcName) return callStack[i];
            }
            return null;
        }, document.uri.fsPath);
    }

    function findInlineCallContexts(document, position) {
        const { text, resolver } = getDocumentTextAndResolver(document);
        return withCtrlCharForContent(text, () => {
            const lineText = document.lineAt(position.line).text;
            const limit = Math.min(position.character, lineText.length);
            const linePrefix = lineText.slice(0, limit);
            const lineStartOffset = document.offsetAt(new vscode.Position(position.line, 0));
            const escapeChar = resolver.ctrlCharAtLine(position.line);
            return collectInlineNamedCallContexts(linePrefix, lineStartOffset, escapeChar);
        }, document.uri.fsPath);
    }

    function findPreferredKnownCallContext(document, position, functions, incDecls, lookup = null, options = {}) {
        const inlineContexts = findInlineCallContexts(document, position);
        const cursorLine = position.line;
        for (let i = inlineContexts.length - 1; i >= 0; i--) {
            if (isKnownFunctionName(inlineContexts[i].funcName, functions, incDecls, lookup)) {
                return inlineContexts[i];
            }
        }

        const contexts = findCallContexts(document, position, options);
        for (let i = contexts.length - 1; i >= 0; i--) {
            const ctx = contexts[i];
            if (!isKnownFunctionName(ctx.funcName, functions, incDecls, lookup)) continue;
            const openLine = document.positionAt(ctx.openOffset).line;
            if (openLine < cursorLine) return ctx;
        }

        for (let i = contexts.length - 1; i >= 0; i--) {
            if (isKnownFunctionName(contexts[i].funcName, functions, incDecls, lookup)) {
                return contexts[i];
            }
        }

        return inlineContexts[inlineContexts.length - 1] ||
            contexts[contexts.length - 1] ||
            null;
    }

    function findParentKnownCallContext(document, childCallCtx, functions, incDecls, lookup = null, options = {}) {
        if (!childCallCtx?.funcName) return null;

        const probeOffset = Math.min(childCallCtx.openOffset + 1, document.getText().length);
        const probePosition = document.positionAt(probeOffset);
        const contexts = findCallContexts(document, probePosition, options);
        if (!contexts.length) return null;

        let childIndex = -1;
        for (let i = contexts.length - 1; i >= 0; i--) {
            if (
                contexts[i].funcName === childCallCtx.funcName &&
                contexts[i].openOffset === childCallCtx.openOffset
            ) {
                childIndex = i;
                break;
            }
        }
        if (childIndex <= 0) return null;

        for (let i = childIndex - 1; i >= 0; i--) {
            if (isKnownFunctionName(contexts[i].funcName, functions, incDecls, lookup)) {
                return contexts[i];
            }
        }

        return null;
    }

    function getArgIndexBeforeOffset(text, openParenOffset, cursorOffset, ctrlCharResolver = null) {
        let d = 0, inStr = false, strChar = '', argIndex = 0;
        for (let i = openParenOffset + 1; i < cursorOffset; i++) {
            const c = text[i];
            if (inStr) {
                const escapeChar = ctrlCharResolver?.ctrlCharAtOffset(i) || getActiveCtrlChar();
                if (c === strChar && !isEscapedQuote(text, i, escapeChar)) inStr = false;
                continue;
            }
            if (c === '"' || c === "'") { inStr = true; strChar = c; continue; }
            if ('[({'.includes(c)) d++;
            else if ('])}'.includes(c)) d = Math.max(0, d - 1);
            else if (c === ',' && d === 0) argIndex++;
        }
        return argIndex;
    }

    function findDefinitionContext(document, position, functions) {
        const candidates = functions
            .filter(f => position.line >= f.startLine && position.line <= (f.headerEndLine ?? f.startLine))
            .sort((a, b) => b.startLine - a.startLine);

        if (!candidates.length) return null;

        const { text, resolver } = getDocumentTextAndResolver(document);
        const cursorOffset = document.offsetAt(position);

        for (const func of candidates) {
            const startOffset = document.offsetAt(new vscode.Position(func.startLine, 0));
            const endLine = func.headerEndLine ?? func.startLine;
            const endLineText = document.lineAt(endLine).text;
            const endOffset = document.offsetAt(new vscode.Position(endLine, endLineText.length));
            const segment = text.slice(startOffset, endOffset);
            const re = createPawnFunctionCallRegex(func.name, escapeRegExp);
            const match = re.exec(segment);
            if (!match) continue;

            const openParenOffset = startOffset + match.index + match[0].lastIndexOf('(');
            const closeParenOffset = findMatchingParenOffset(text, openParenOffset, endOffset, resolver);
            if (closeParenOffset < 0) continue;
            if (cursorOffset <= openParenOffset || cursorOffset > closeParenOffset) continue;

            return {
                funcName: func.name,
                argIndex: getArgIndexBeforeOffset(text, openParenOffset, cursorOffset, resolver),
                openOffset: openParenOffset,
                closeOffset: closeParenOffset,
                isDefinition: true
            };
        }

        return null;
    }

    function isNearbyCallContext(document, position, callCtx, maxLineDistance = 20, maxCharDistance = 1200) {
        if (!callCtx?.funcName) return false;

        const cursorOffset = document.offsetAt(position);
        const openPosition = document.positionAt(callCtx.openOffset);
        const lineDistance = position.line - openPosition.line;
        const charDistance = cursorOffset - callCtx.openOffset;

        if (lineDistance < 0 || charDistance < 0) return false;
        if (lineDistance > maxLineDistance) return false;
        if (charDistance > maxCharDistance) return false;

        return true;
    }

    function isMeaningfulCallPosition(document, position, callCtx = null, options = {}) {
        const ctx = callCtx || findCallContext(document, position, options);
        if (!ctx?.funcName) return false;
        if (!isNearbyCallContext(document, position, ctx)) return false;

        const { text, resolver } = getDocumentTextAndResolver(document);
        const cursorOffset = document.offsetAt(position);
        const closeOffset = findMatchingParenOffset(text, ctx.openOffset, text.length, resolver, options);
        if (cursorOffset <= ctx.openOffset) return false;
        if (closeOffset >= 0 && cursorOffset >= closeOffset) return false;
        if (isWithinMeaningfulCallArgument(text, cursorOffset, ctx, resolver, options)) return true;

        const prev = text[cursorOffset - 1] || '';
        const curr = text[cursorOffset] || '';
        const isIgnorable = ch => !ch || /\s/.test(ch) || ch === ',' || ch === '(' || ch === ')';

        // Keep signature hover alive on neutral separators inside a real arg,
        // but do not treat arbitrary positions in the whole call range as meaningful.
        const looksLikeInnerArgGap =
            (/[\w\]\)"']/.test(prev) && /[\w\[\("_@]/.test(curr)) ||
            (/[\w\]\)"']/.test(prev) && isIgnorable(curr)) ||
            (isIgnorable(prev) && /[\w\[\("_@]/.test(curr));
        if (looksLikeInnerArgGap) return true;

        if (curr === ')' || curr === ',') return false;
        if ((prev === '(' || prev === ',') && isIgnorable(curr)) return false;
        if (isIgnorable(prev) && isIgnorable(curr)) return false;

        return true;
    }

    function isMeaningfulCallCursorPosition(document, position, callCtx = null, options = {}) {
        if (isMeaningfulCallPosition(document, position, callCtx, options)) return true;

        const ctx = callCtx || findCallContext(document, position, options);
        if (!ctx?.funcName) return false;
        if (!isNearbyCallContext(document, position, ctx)) return false;

        const { text, resolver } = getDocumentTextAndResolver(document);
        const cursorOffset = document.offsetAt(position);
        const closeOffset = findMatchingParenOffset(text, ctx.openOffset, text.length, resolver, options);
        if (cursorOffset <= ctx.openOffset) return false;
        if (closeOffset >= 0 && cursorOffset > closeOffset) return false;
        if (isWithinMeaningfulCallArgument(text, cursorOffset, ctx, resolver, options)) return true;

        const prev = text[cursorOffset - 1] || '';
        const curr = text[cursorOffset] || '';
        const looksLikeArgTail =
            /[\w\]\)"']/.test(prev) &&
            (curr === ',' || curr === ')');

        if (position.line > document.positionAt(ctx.openOffset).line) return true;
        return looksLikeArgTail;
    }

    function findFunctionCallNameContext(document, position, functions, incDecls, activeCallCtx = null, lookup = null, options = {}) {
        const range = document.getWordRangeAtPosition(position);
        if (!range) return null;

        const funcName = document.getText(range);

        const { text, resolver } = getDocumentTextAndResolver(document);
        let scanOffset = document.offsetAt(range.end);
        while (scanOffset < text.length && /\s/.test(text[scanOffset])) scanOffset++;
        if (text[scanOffset] !== '(') return null;
        if (!isKnownFunctionName(funcName, functions, incDecls, lookup)) return null;

        const matchingActiveCall =
            activeCallCtx &&
            activeCallCtx.funcName === funcName &&
            activeCallCtx.openOffset === scanOffset
                ? activeCallCtx
                : null;

        return {
            funcName,
            openOffset: scanOffset,
            argIndex: matchingActiveCall ? matchingActiveCall.argIndex : null,
            closeOffset: findMatchingParenOffset(text, scanOffset, text.length, resolver, options),
            isCallName: true
        };
    }

    function findNestedParentCallNameContext(document, position, functions, incDecls, lookup = null, options = {}) {
        const callNameCtx = findFunctionCallNameContext(document, position, functions, incDecls, null, lookup, options);
        if (!callNameCtx) return { callNameCtx: null, parentCallCtx: null };
        return {
            callNameCtx,
            parentCallCtx: findParentKnownCallContext(document, callNameCtx, functions, incDecls, lookup, options)
        };
    }

    return {
        buildCallArgLayout,
        collectCallArgumentIssues,
        getObjectLikeDefineTupleTexts,
        expandObjectLikeDefineTupleCallArgs,
        expandObjectLikeDefineTupleArgPieces,
        hasExpandableObjectLikeDefineTupleArg,
        createDocumentCallContextIndex,
        createLazyCallContextOptions,
        collectInlineNamedCallContexts,
        extractCallSiteArgs,
        findMatchingParenOffset,
        getPreferredFunctionHoverMatch,
        findCallContext,
        findCallContexts,
        findInlineCallContext,
        findInlineCallContexts,
        findPreferredKnownCallContext,
        findParentKnownCallContext,
        isNearbyCallContext,
        isMeaningfulCallPosition,
        isMeaningfulCallCursorPosition,
        getWordAtPosition,
        findDefinitionContext,
        findFunctionCallNameContext,
        findNestedParentCallNameContext
    };
}

module.exports = { createCallAnalysisCore };
