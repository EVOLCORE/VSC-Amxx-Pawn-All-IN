const { createStructuralRangeHelpers } = require('./structural-ranges');
const { getStructuralScanBounds } = require('./structural-scan-bounds');

function createStructuralDiagnostics(deps) {
    const {
        areWarningDiagnosticsEnabled,
        classifyPawnStatementLine,
        countStructuralBraces,
        countTopLevelSemicolonStatements,
        createHoverTypeAnalysisCache,
        createLiveValidationDiagnostic,
        createOffsetRange,
        evaluatePawnNumericExpr,
        explainArrayShapeDiagnosticIssue,
        findBalancedGroupEnd,
        findPossiblyUnintendedAssignmentInCondition,
        findDuplicateSwitchCaseEntry,
        findFirstNonWhitespaceIndex,
        findKeywordOccurrences,
        getConstantControlTestIssue: getConstantControlTestWarningIssue,
        getFunctionBodyRangeByLine,
        getFunctionShouldReturnValueIssue,
        getLiveArrayShapeIssue,
        getStateStatementIssues,
        getNoEffectConstantStatementIssue,
        getStatementHasNoEffectIssue,
        getUnreachableCodeIssue,
        getWarningSeverity,
        hasControlInlinePrefix,
        inferArrayShapeActualType,
        isFunctionHeaderLine,
        isIncludeDocument,
        isKeywordAt,
        isLocalDeclarationStatementStart,
        isPreprocessorDirectiveOrContinuationLine,
        maskStringLiteralContent,
        mayHaveInlineStatementPrefix,
        rememberSwitchCaseEntry,
        resolveSwitchCaseLabelValues,
        shouldIncludeTargetLine,
        skipInlineControlHeader,
        stripLeadingInlineStatementPrefix,
        stripTrailingSemicolon,
        t,
        vscode
    } = deps;

    function collectStructuralLiveDiagnostics(document, rootCtx, docLength, targetLineNumbers = null, scanServices = null) {
        const diagnostics = [];
        const includeDocument = isIncludeDocument(document);
        const targetLines = targetLineNumbers instanceof Set ? targetLineNumbers : null;
        const rawLines = rootCtx.rawLines || rootCtx.text.split(/\r?\n/);
        const strippedLines = rootCtx.strippedLines || rawLines;
        const depths = rootCtx.parsedDecls.depths || [];
        const lineStartOffsets = rootCtx.lineStartOffsets || null;
        const getLineStartOffset = lineNumber =>
            lineStartOffsets?.[lineNumber] ?? document.offsetAt(new vscode.Position(lineNumber, 0));
        const structuralCandidateLineNumbers = rootCtx.lineIndex.structuralDiagnosticCandidateLines || [];
        const unreachableCandidateLineNumbers = rootCtx.lineIndex.generalDiagnosticCandidateLines || [];
        const functionBodyRangeByLine = getFunctionBodyRangeByLine(rootCtx);
        const functionHeaderEndLines = (() => {
            const lines = new Set();
            for (const func of rootCtx.parsedDecls.functions || []) {
                const endLine = func.headerEndLine ?? func.startLine;
                if (Number.isInteger(endLine) && endLine >= 0) {
                    lines.add(endLine);
                }
            }
            return lines;
        })();
        const scanBounds = getStructuralScanBounds({
            targetLines,
            strippedLines,
            functions: rootCtx.parsedDecls.functions || [],
            functionBodyRangeByLine
        });
        const returnStyleByFunction = new Map();
        const terminalStateByFunction = new Map();
        const blockContexts = [];
        const singleLineContexts = [];
        const getReturnLineContext = lineNumber =>
            scanServices?.getLineContext?.(lineNumber) || rootCtx;
        const getReturnAnalysisCache = (lineNumber, lineCtx) =>
            scanServices?.getAnalysisCacheForLine?.(lineNumber, lineCtx) ||
            createHoverTypeAnalysisCache([], lineCtx?.lookup || rootCtx.lookup);
        const getCheapScalarReturnTypeInfo = valueText => {
            const source = String(valueText || '').trim();
            if (!source) return null;
            const scalarLiteralSource = source
                .replace(/^\(+\s*/, '')
                .replace(/\s*\)+$/, '')
                .trim();
            if (
                /^(?:[A-Za-z_@]\w*:\s*)?(?:true|false|cellmin|cellmax)$/i.test(scalarLiteralSource) ||
                /^(?:[A-Za-z_@]\w*:\s*)?(?:[-+~!]\s*)?(?:0x[0-9A-Fa-f]+|\d+(?:\.\d+)?)$/.test(scalarLiteralSource) ||
                /^'(?:\\.|[^'\\])'$/.test(scalarLiteralSource)
            ) {
                return {
                    type: { tag: '', dims: '' },
                    decls: [],
                    analysisCache: null,
                    escapeChar: ''
                };
            }
            return null;
        };
        const getReturnValueTypeInfo = (lineNumber, valueText) => {
            const cheapScalar = getCheapScalarReturnTypeInfo(valueText);
            if (cheapScalar) return cheapScalar;
            const returnCtx = getReturnLineContext(lineNumber);
            const returnAnalysisCache = getReturnAnalysisCache(lineNumber, returnCtx);
            const returnDecls = returnAnalysisCache ? [] : (returnCtx?.allDecls || rootCtx.allDecls);
            const { type: returnType } = inferArrayShapeActualType(valueText, returnDecls, returnAnalysisCache);
            return {
                type: returnType || { tag: '', dims: '' },
                decls: returnDecls,
                analysisCache: returnAnalysisCache,
                escapeChar: returnCtx?.resolver?.ctrlCharAtLine?.(lineNumber) || ''
            };
        };

        const findNextNonEmptyLine = startLine => {
            for (let probeLine = startLine; probeLine < strippedLines.length; probeLine++) {
                if (String(strippedLines[probeLine] || '').trim()) return probeLine;
            }
            return startLine;
        };
        const findPreviousNonEmptyLine = startLine => {
            for (let probeLine = startLine; probeLine >= 0; probeLine--) {
                if (String(strippedLines[probeLine] || '').trim()) return probeLine;
            }
            return -1;
        };
        const isDoWhileClosingLine = lineNumber => {
            const trimmedLine = String(strippedLines[lineNumber] || '').trim();
            if (!/^while\s*\([^)]*\)\s*;?$/.test(trimmedLine)) return false;
            const previousNonEmptyLine = findPreviousNonEmptyLine(lineNumber - 1);
            if (previousNonEmptyLine < 0) return false;
            const previousTrimmedLine = String(strippedLines[previousNonEmptyLine] || '').trim();
            return /}\s*$/.test(previousTrimmedLine);
        };
        const isTopLevelBraceStartWithoutHeader = lineNumber => {
            const trimmedLine = String(strippedLines[lineNumber] || '').trim();
            if (!/^\{/.test(trimmedLine)) return false;
            const previousNonEmptyLine = findPreviousNonEmptyLine(lineNumber - 1);
            if (previousNonEmptyLine < 0) return true;
            const previousTrimmedLine = String(strippedLines[previousNonEmptyLine] || '').trim();
            if (!previousTrimmedLine) return true;
            if (functionHeaderEndLines.has(previousNonEmptyLine)) return false;
            const previousStatement = classifyPawnStatementLine(previousTrimmedLine);
            if (
                previousStatement.firstKeyword === 'if' ||
                previousStatement.firstKeyword === 'for' ||
                previousStatement.firstKeyword === 'while' ||
                previousStatement.firstKeyword === 'switch' ||
                previousStatement.firstKeyword === 'do' ||
                previousStatement.firstKeyword === 'else' ||
                previousStatement.firstKeyword === 'enum' ||
                previousStatement.firstKeyword === 'new' ||
                previousStatement.firstKeyword === 'static' ||
                previousStatement.firstKeyword === 'const'
            ) {
                return false;
            }
            if (/[=,]\s*$/.test(previousTrimmedLine)) return false;
            if (/^[A-Za-z_@]\w*\s*:\s*$/.test(previousTrimmedLine)) return false;
            return true;
        };
        const hasInlineContextBefore = (source, keywordIndex, keyword) => {
            const prefix = String(source || '').slice(0, keywordIndex);
            if (keyword === 'break') {
                const starts = findKeywordOccurrences(prefix, ['for', 'while', 'switch', 'do']);
                const last = starts[starts.length - 1] || null;
                if (!last) return false;
                if (last.keyword === 'do') return prefix.slice(last.end).trim() !== ';';
                return skipInlineControlHeader(prefix, last.start, last.keyword) === prefix.length;
            }
            if (keyword === 'continue') {
                const starts = findKeywordOccurrences(prefix, ['for', 'while', 'do']);
                const last = starts[starts.length - 1] || null;
                if (!last) return false;
                if (last.keyword === 'do') return prefix.slice(last.end).trim() !== ';';
                return skipInlineControlHeader(prefix, last.start, last.keyword) === prefix.length;
            }
            return false;
        };
        const {
            createFunctionNameRange,
            createKeywordRange,
            createSwitchCaseLabelRange
        } = createStructuralRangeHelpers({
            document,
            docLength,
            rawLines,
            getLineStartOffset,
            createOffsetRange
        });
        const functionBodyDepthByFunction = new Map();
        for (const func of rootCtx.parsedDecls.functions || []) {
            const headerEndLine = func.headerEndLine ?? func.startLine ?? func.lineNumber ?? 0;
            const headerDepth = depths[headerEndLine] ?? depths[func.startLine ?? func.lineNumber ?? 0] ?? 0;
            functionBodyDepthByFunction.set(func, headerDepth + 1);
        }
        const getControlConditionExpression = (source, keywordStart, keyword) => {
            if (keyword !== 'if' && keyword !== 'while') return '';
            const text = String(source || '');
            let index = findFirstNonWhitespaceIndex(text, keywordStart + keyword.length);
            if (text[index] !== '(') return '';
            const closeIndex = findBalancedGroupEnd(text, index, '(', ')');
            return closeIndex > index ? text.slice(index + 1, closeIndex).trim() : '';
        };
        const getConstantControlTestIssue = (lineNumber, structuralLine, statement) => {
            const keyword = statement.firstKeyword;
            if (keyword !== 'if' && keyword !== 'while') return null;
            if (keyword === 'while' && isDoWhileClosingLine(lineNumber)) return null;
            const expr = getControlConditionExpression(
                structuralLine,
                statement.firstKeywordStart,
                keyword
            );
            if (!expr) return null;
            const lineCtx = getReturnLineContext(lineNumber);
            const analysisCache = getReturnAnalysisCache(lineNumber, lineCtx);
            const decls = analysisCache ? [] : (lineCtx?.allDecls || rootCtx.allDecls);
            const value = evaluatePawnNumericExpr(expr, decls, new Set(), analysisCache);
            if (value == null) return null;
            return getConstantControlTestWarningIssue(value);
        };
        const getConditionAssignmentIssue = (structuralLine, statement) => {
            if (statement.firstKeyword !== 'if' && statement.firstKeyword !== 'while') return null;
            return findPossiblyUnintendedAssignmentInCondition(
                structuralLine,
                statement.firstKeywordStart,
                statement.firstKeyword
            );
        };
        const pushControlContext = (type, lineNumber, sourceText, currentDepth, keywordIndex = -1) => {
            const source = String(sourceText || '');
            const resolvedKeywordIndex = keywordIndex >= 0
                ? keywordIndex
                : findKeywordOccurrences(source, [type])[0]?.start ?? -1;
            if (resolvedKeywordIndex < 0) return;
            const lineRemainder = source.slice(resolvedKeywordIndex);
            const hasBraceBodyOnLine = /\{/.test(lineRemainder);
            if (hasBraceBodyOnLine) {
                const bodyDepth = currentDepth + 1;
                blockContexts.push({
                    type,
                    startLine: lineNumber,
                    bodyDepth,
                    braceBalance: countStructuralBraces(lineRemainder),
                    braceTrackingStartLine: lineNumber,
                    caseValues: new Set(),
                    caseRanges: [],
                    seenDefault: false
                });
                return;
            }

            const nextBodyLine = findNextNonEmptyLine(lineNumber + 1);
            const nextBodyText = String(strippedLines[nextBodyLine] || '').trim();
            const nextDepth = depths[nextBodyLine] ?? currentDepth;
            if (nextBodyLine < strippedLines.length && /^\{/.test(nextBodyText)) {
                blockContexts.push({
                    type,
                    startLine: lineNumber,
                    bodyDepth: currentDepth + 1,
                    braceBalance: 0,
                    braceTrackingStartLine: nextBodyLine,
                    caseValues: new Set(),
                    caseRanges: [],
                    seenDefault: false
                });
                return;
            }
            if (nextBodyLine < strippedLines.length && nextDepth > currentDepth) {
                blockContexts.push({
                    type,
                    startLine: lineNumber,
                    bodyDepth: nextDepth,
                    caseValues: new Set(),
                    caseRanges: [],
                    seenDefault: false
                });
                return;
            }

            singleLineContexts.push({
                type,
                startLine: lineNumber,
                untilLine: nextBodyLine
            });
        };
        const isUnreachableResetLine = trimmedLine =>
            /^(?:case\b|default\b|else\b)/.test(trimmedLine) ||
            /^[A-Za-z_@]\w*\s*:\s*$/.test(trimmedLine);
        const isExecutableStatementForUnreachable = trimmedLine => {
            if (!trimmedLine) return false;
            if (/^[{};]+$/.test(trimmedLine)) return false;
            if (/^#/.test(trimmedLine)) return false;
            if (isUnreachableResetLine(trimmedLine)) return false;
            return true;
        };
        const updateFunctionTerminalState = (lineNumber, functionBody, trimmedLine, statement) => {
            const func = functionBody?.func || null;
            if (!func || !isExecutableStatementForUnreachable(trimmedLine)) return;
            const currentDepth = depths[lineNumber] ?? 0;
            const isFunctionSingleStatementBody =
                Number.isInteger(func.singleStatementBodyLine) &&
                func.singleStatementBodyLine === lineNumber;
            const baseDepth = isFunctionSingleStatementBody
                ? currentDepth
                : functionBodyDepthByFunction.get(func);
            terminalStateByFunction.set(func, {
                hasFunctionLevelTerminal:
                    currentDepth === baseDepth &&
                    !isSingleStatementControlledBodyLine(lineNumber) &&
                    (statement.firstKeyword === 'return' || statement.firstKeyword === 'goto')
            });
        };
        const isWholeLineTerminalStatement = trimmedLine =>
            /^return\b/.test(trimmedLine);
        const isSingleStatementControlledBodyLine = lineNumber => {
            let combined = '';
            for (let probeLine = lineNumber - 1, scanned = 0; probeLine >= 0 && scanned < 12; probeLine--, scanned++) {
                const trimmed = String(strippedLines[probeLine] || '').trim();
                if (!trimmed) continue;
                combined = combined ? `${trimmed} ${combined}` : trimmed;
                if (/;\s*$/.test(trimmed) || /\{\s*$/.test(trimmed) || /^\}/.test(trimmed)) return false;
                const statement = classifyPawnStatementLine(combined);
                if (
                    statement.firstKeyword === 'if' ||
                    statement.firstKeyword === 'for' ||
                    (statement.firstKeyword === 'while' && !isDoWhileClosingLine(probeLine)) ||
                    statement.firstKeyword === 'else' ||
                    statement.firstKeyword === 'do'
                ) {
                    return true;
                }
                const previousLine = findPreviousNonEmptyLine(probeLine - 1);
                const previousTrimmed = previousLine >= 0
                    ? String(strippedLines[previousLine] || '').trim()
                    : '';
                const startsContinuation = /^(?:&&|\|\||[+\-*/%&|^<>=!?:,])/.test(trimmed);
                const previousContinues = /(?:&&|\|\||[+\-*/%&|^<>=!?:,])\s*$/.test(previousTrimmed) ||
                    /\(\s*$/.test(previousTrimmed);
                if (!startsContinuation && !previousContinues) return false;
            }
            return false;
        };
        const structuralLineCache = [];
        const getStructuralLine = lineNumber => {
            const cached = structuralLineCache[lineNumber];
            if (cached !== undefined) return cached;
            const escapeChar = rootCtx.resolver?.ctrlCharAtLine?.(lineNumber) || '';
            const line = maskStringLiteralContent(String(strippedLines[lineNumber] || ''), escapeChar);
            structuralLineCache[lineNumber] = line;
            return line;
        };
        const getTrimmedStructuralLine = lineNumber =>
            String(getStructuralLine(lineNumber) || '').trim();
        const isCompilerLaststIgnoredLine = trimmedLine =>
            !trimmedLine ||
            /^[{}]+;?$/.test(trimmedLine) ||
            /^#/.test(trimmedLine);
        const findNextCompilerStatementLine = (startLine, endLine) => {
            for (let line = Math.max(0, startLine); line <= endLine; line++) {
                const trimmed = getTrimmedStructuralLine(line);
                if (isCompilerLaststIgnoredLine(trimmed)) continue;
                return line;
            }
            return -1;
        };
        const getFunctionBodyRangeForFunction = func => {
            const headerEndLine = func?.headerEndLine ?? func?.startLine ?? func?.lineNumber ?? -1;
            for (let line = Math.max(0, headerEndLine + 1); line < strippedLines.length; line++) {
                const range = functionBodyRangeByLine[line] || null;
                if (range?.func === func) return range;
                if ((depths[line] ?? 0) <= (depths[headerEndLine] ?? 0) && line > headerEndLine + 1) break;
            }
            return null;
        };
        const lineStartsWithKeyword = (trimmedLine, keyword) =>
            trimmedLine === keyword || trimmedLine.startsWith(`${keyword} `) || trimmedLine.startsWith(`${keyword}(`);
        const getStatementTerminalKindFromText = text => {
            const trimmed = String(text || '').trim();
            if (lineStartsWithKeyword(trimmed, 'return')) return 'return';
            if (lineStartsWithKeyword(trimmed, 'goto')) return 'goto';
            return '';
        };
        const findStructuralBlockEndLine = (startLine, endLine) => {
            let balance = 0;
            let sawOpen = false;
            for (let line = startLine; line <= endLine; line++) {
                const braceDelta = countStructuralBraces(getStructuralLine(line));
                if (getStructuralLine(line).includes('{')) sawOpen = true;
                balance += braceDelta;
                if (sawOpen && balance <= 0) return line;
            }
            return -1;
        };
        const getCompilerLikeTerminalKindForRange = (startLine, endLine, baseDepth) => {
            let lastStatementLine = -1;
            for (let line = Math.max(0, startLine); line <= endLine; line++) {
                const trimmed = getTrimmedStructuralLine(line);
                if (isCompilerLaststIgnoredLine(trimmed)) continue;
                if ((depths[line] ?? baseDepth) !== baseDepth) continue;
                if (lineStartsWithKeyword(trimmed, 'else')) continue;
                if (isSingleStatementControlledBodyLine(line)) continue;
                lastStatementLine = line;
            }
            return lastStatementLine >= 0
                ? getCompilerLikeTerminalKindForStatement(lastStatementLine, endLine, baseDepth)
                : '';
        };
        const getCompilerLikeTerminalKindForBranch = (startLine, endLine, parentDepth) => {
            const firstLine = findNextCompilerStatementLine(startLine, endLine);
            if (firstLine < 0) return { kind: '', endLine: startLine };
            const trimmed = getTrimmedStructuralLine(firstLine);
            if (trimmed.startsWith('{') || (depths[firstLine] ?? parentDepth) > parentDepth) {
                const blockStartLine = trimmed.startsWith('{') ? firstLine : Math.max(startLine, firstLine - 1);
                const blockEndLine = findStructuralBlockEndLine(blockStartLine, endLine);
                if (blockEndLine < 0) return { kind: '', endLine: firstLine };
                return {
                    kind: getCompilerLikeTerminalKindForRange(firstLine, blockEndLine - 1, parentDepth + 1),
                    endLine: blockEndLine
                };
            }
            return {
                kind: getCompilerLikeTerminalKindForStatement(firstLine, endLine, depths[firstLine] ?? parentDepth),
                endLine: firstLine
            };
        };
        const getControlInlineBodyStart = (lineNumber, keywordStart, keyword) => {
            const line = getStructuralLine(lineNumber);
            const start = skipInlineControlHeader(line, keywordStart, keyword);
            return Number.isInteger(start) && start >= 0 ? start : -1;
        };
        const getCompilerLikeIfTerminalKind = (ifLine, endLine, baseDepth) => {
            let currentIfLine = ifLine;
            let expectedKind = '';
            for (let guard = 0; guard < 64; guard++) {
                const currentLine = getStructuralLine(currentIfLine);
                const currentTrimmed = currentLine.trim();
                const ifKeywordIndex = currentTrimmed.startsWith('else')
                    ? currentLine.indexOf('if', currentLine.indexOf('else') + 4)
                    : currentLine.indexOf('if');
                if (ifKeywordIndex < 0) return '';
                const inlineBodyStart = getControlInlineBodyStart(currentIfLine, ifKeywordIndex, 'if');
                const inlineBody = inlineBodyStart >= 0
                    ? currentLine.slice(inlineBodyStart).trim()
                    : '';
                const branch = inlineBody && inlineBody !== '{'
                    ? { kind: getStatementTerminalKindFromText(inlineBody), endLine: currentIfLine }
                    : getCompilerLikeTerminalKindForBranch(currentIfLine + 1, endLine, baseDepth);
                if (!branch.kind) return '';
                if (!expectedKind) expectedKind = branch.kind;
                if (branch.kind !== expectedKind) return '';

                const elseLine = findNextCompilerStatementLine(branch.endLine + 1, endLine);
                if (elseLine < 0) return '';
                if ((depths[elseLine] ?? baseDepth) !== baseDepth) return '';
                const elseText = getTrimmedStructuralLine(elseLine);
                if (!lineStartsWithKeyword(elseText, 'else')) return '';
                const elseKeywordStart = getStructuralLine(elseLine).indexOf('else');
                const afterElseStart = getControlInlineBodyStart(elseLine, elseKeywordStart, 'else');
                const afterElse = afterElseStart >= 0
                    ? getStructuralLine(elseLine).slice(afterElseStart).trim()
                    : '';
                if (lineStartsWithKeyword(afterElse, 'if')) {
                    currentIfLine = elseLine;
                    continue;
                }
                const elseBranch = afterElse && afterElse !== '{'
                    ? { kind: getStatementTerminalKindFromText(afterElse), endLine: elseLine }
                    : getCompilerLikeTerminalKindForBranch(elseLine + 1, endLine, baseDepth);
                return elseBranch.kind === expectedKind ? expectedKind : '';
            }
            return '';
        };
        function getCompilerLikeTerminalKindForStatement(lineNumber, endLine, baseDepth) {
            const trimmed = getTrimmedStructuralLine(lineNumber);
            const directKind = getStatementTerminalKindFromText(trimmed);
            if (directKind) return directKind;
            if (lineStartsWithKeyword(trimmed, 'if')) {
                return getCompilerLikeIfTerminalKind(lineNumber, endLine, baseDepth);
            }
            return '';
        }
        const hasCompilerLikeFunctionTerminal = func => {
            const bodyRange = getFunctionBodyRangeForFunction(func);
            if (!bodyRange) return false;
            const baseDepth = functionBodyDepthByFunction.get(func) ?? 1;
            const terminalKind = getCompilerLikeTerminalKindForRange(
                bodyRange.startLine,
                bodyRange.endLine,
                baseDepth
            );
            return terminalKind === 'return' || terminalKind === 'goto';
        };
        const collectUnreachableCodeDiagnostics = () => {
            const result = [];
            const terminalLineByFunctionDepth = new Map();
            let activeFuncKey = null;

            const processUnreachableLine = lineNumber => {
                const functionBody = functionBodyRangeByLine[lineNumber] || null;
                if (!functionBody) {
                    activeFuncKey = null;
                    terminalLineByFunctionDepth.clear();
                    return;
                }
                if (activeFuncKey !== functionBody.func) {
                    activeFuncKey = functionBody.func;
                    terminalLineByFunctionDepth.clear();
                }

                const structuralLine = getStructuralLine(lineNumber);
                const trimmedLine = structuralLine.trim();
                if (!trimmedLine || isPreprocessorDirectiveOrContinuationLine(rootCtx, lineNumber, trimmedLine)) {
                    return;
                }
                const currentDepth = depths[lineNumber] ?? 0;
                for (const depth of [...terminalLineByFunctionDepth.keys()]) {
                    if (depth > currentDepth) terminalLineByFunctionDepth.delete(depth);
                }
                if (isUnreachableResetLine(trimmedLine)) {
                    terminalLineByFunctionDepth.delete(currentDepth);
                }
                const terminalLine = terminalLineByFunctionDepth.get(currentDepth);
                if (
                    terminalLine != null &&
                    terminalLine < lineNumber &&
                    isExecutableStatementForUnreachable(trimmedLine) &&
                    shouldIncludeTargetLine(targetLines, lineNumber)
                ) {
                    const rawLine = String(rawLines[lineNumber] || '');
                    const lineStartOffset = getLineStartOffset(lineNumber);
                    const firstVisibleIndex = rawLine.search(/\S|$/);
                    const issue = getUnreachableCodeIssue();
                    result.push(
                        createLiveValidationDiagnostic(
                            createOffsetRange(
                                document,
                                lineStartOffset + Math.max(0, firstVisibleIndex),
                                lineStartOffset + Math.max(1, rawLine.length),
                                docLength
                            ),
                            t(issue.messageKey, issue.params || {}),
                            getWarningSeverity()
                        )
                    );
                }
                if (isWholeLineTerminalStatement(trimmedLine) && !isSingleStatementControlledBodyLine(lineNumber)) {
                    terminalLineByFunctionDepth.set(currentDepth, lineNumber);
                } else if (isExecutableStatementForUnreachable(trimmedLine)) {
                    terminalLineByFunctionDepth.delete(currentDepth);
                }
            };

            for (const lineNumber of unreachableCandidateLineNumbers) {
                if (lineNumber < scanBounds.start) continue;
                if (lineNumber > scanBounds.end) break;
                processUnreachableLine(lineNumber);
            }

            return result;
        };

        let structuralCandidateIndex = 0;
        while (
            structuralCandidateIndex < structuralCandidateLineNumbers.length &&
            structuralCandidateLineNumbers[structuralCandidateIndex] < scanBounds.start
        ) {
            structuralCandidateIndex++;
        }
        for (let lineNumber = scanBounds.start; lineNumber <= scanBounds.end; lineNumber++) {
            const candidateLine = structuralCandidateLineNumbers[structuralCandidateIndex];
            if (candidateLine == null || candidateLine > scanBounds.end) break;
            if (lineNumber !== candidateLine) lineNumber = candidateLine;
            structuralCandidateIndex++;
            const structuralLine = getStructuralLine(lineNumber);
            const trimmedLine = structuralLine.trim();
            const currentDepth = depths[lineNumber] ?? 0;
            if (!trimmedLine) continue;
            if (isPreprocessorDirectiveOrContinuationLine(rootCtx, lineNumber, trimmedLine)) continue;
            const statement = classifyPawnStatementLine(structuralLine);

            while (
                blockContexts.length &&
                lineNumber > blockContexts[blockContexts.length - 1].startLine &&
                blockContexts[blockContexts.length - 1].braceBalance == null &&
                currentDepth < blockContexts[blockContexts.length - 1].bodyDepth &&
                !/^\s*\{/.test(trimmedLine)
            ) {
                blockContexts.pop();
            }
            while (singleLineContexts.length && singleLineContexts[0].untilLine < lineNumber) {
                singleLineContexts.shift();
            }

            let activeBlockSwitch = null;
            let hasBlockLoop = false;
            for (let contextIndex = blockContexts.length - 1; contextIndex >= 0; contextIndex--) {
                const context = blockContexts[contextIndex];
                const type = context?.type || '';
                if (!activeBlockSwitch && type === 'switch') {
                    activeBlockSwitch = context;
                }
                if (type === 'for' || type === 'while' || type === 'do') {
                    hasBlockLoop = true;
                }
                if (activeBlockSwitch && hasBlockLoop) break;
            }
            let activeSingleSwitch = null;
            let activeSingleStatementContext = null;
            let hasSingleLineLoop = false;
            for (const context of singleLineContexts) {
                const type = context?.type || '';
                if (!activeSingleSwitch && type === 'switch') {
                    activeSingleSwitch = context;
                }
                if (!activeSingleStatementContext && type !== 'switch') {
                    activeSingleStatementContext = context;
                }
                if (type === 'for' || type === 'while' || type === 'do') {
                    hasSingleLineLoop = true;
                }
                if (activeSingleSwitch && activeSingleStatementContext && hasSingleLineLoop) break;
            }
            const activeSwitch = activeBlockSwitch || activeSingleSwitch;
            const hasActiveLoop = hasBlockLoop || hasSingleLineLoop;
            const hasActiveBreakContext = hasActiveLoop || !!activeSwitch;
            const switchLabel = statement.switchLabel;
            const caseMatch = switchLabel?.kind === 'case' ? switchLabel : null;
            const defaultMatch = switchLabel?.kind === 'default';
            const inlineCaseBody = switchLabel?.inlineBody || '';

            if (
                !includeDocument &&
                currentDepth === 0 &&
                !functionBodyRangeByLine[lineNumber] &&
                !isFunctionHeaderLine(rootCtx, lineNumber)
            ) {
                if (trimmedLine.startsWith('{') && isTopLevelBraceStartWithoutHeader(lineNumber) && shouldIncludeTargetLine(targetLines, lineNumber)) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, '{'),
                            t('validation.startOfFunctionBodyWithoutHeader')
                        )
                    );
                    continue;
                }
                const invalidOutsideKeyword = (
                    statement.firstKeyword === 'if' ||
                    statement.firstKeyword === 'for' ||
                    statement.firstKeyword === 'while' ||
                    statement.firstKeyword === 'switch' ||
                    statement.firstKeyword === 'do' ||
                    statement.firstKeyword === 'else' ||
                    statement.firstKeyword === 'return' ||
                    statement.firstKeyword === 'state' ||
                    statement.firstKeyword === 'goto' ||
                    statement.firstKeyword === 'assert' ||
                    statement.firstKeyword === 'sleep' ||
                    statement.firstKeyword === 'exit'
                )
                    ? statement.firstKeyword
                    : '';
                if (invalidOutsideKeyword && shouldIncludeTargetLine(targetLines, lineNumber)) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, invalidOutsideKeyword, statement.firstKeywordStart),
                            t('validation.invalidOutsideFunctions')
                        )
                    );
                    continue;
                }
                const invalidOutsideConstantIssue = getNoEffectConstantStatementIssue(structuralLine);
                if (invalidOutsideConstantIssue && shouldIncludeTargetLine(targetLines, lineNumber)) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, invalidOutsideConstantIssue.text, invalidOutsideConstantIssue.start),
                            t('validation.invalidOutsideFunctions')
                        )
                    );
                    continue;
                }
            }

            if (functionBodyRangeByLine[lineNumber]) {
                const isWholeLineEmptyStatement = trimmedLine === ';';
                let isInlineEmptyStatement = false;
                if (!isWholeLineEmptyStatement && trimmedLine.endsWith(';') && mayHaveInlineStatementPrefix(structuralLine)) {
                    const inlinePrefix = stripLeadingInlineStatementPrefix(structuralLine);
                    isInlineEmptyStatement =
                        hasControlInlinePrefix(inlinePrefix) &&
                        inlinePrefix.startOffset > 0 &&
                        inlinePrefix.text.trim() === ';';
                }
                if (shouldIncludeTargetLine(targetLines, lineNumber) && (isWholeLineEmptyStatement || isInlineEmptyStatement)) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, ';'),
                            t('validation.emptyStatement')
                        )
                    );
                    continue;
                }

                const noEffectConstantIssue = getNoEffectConstantStatementIssue(structuralLine);
                if (shouldIncludeTargetLine(targetLines, lineNumber) && noEffectConstantIssue) {
                    const warningIssue = getStatementHasNoEffectIssue(noEffectConstantIssue);
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, noEffectConstantIssue.text, noEffectConstantIssue.start),
                            t(warningIssue?.messageKey || 'validation.statementHasNoEffect', warningIssue?.params || {}),
                            warningIssue?.severity === 'warning' ? getWarningSeverity() : undefined
                        )
                    );
                    continue;
                }

                const constantControlTestIssue = getConstantControlTestIssue(lineNumber, structuralLine, statement);
                if (areWarningDiagnosticsEnabled() && shouldIncludeTargetLine(targetLines, lineNumber) && constantControlTestIssue) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, statement.firstKeyword, statement.firstKeywordStart),
                            t(constantControlTestIssue.messageKey, constantControlTestIssue.params || {}),
                            getWarningSeverity()
                        )
                    );
                }
                const conditionAssignmentIssue = getConditionAssignmentIssue(structuralLine, statement);
                if (areWarningDiagnosticsEnabled() && shouldIncludeTargetLine(targetLines, lineNumber) && conditionAssignmentIssue) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, '=', conditionAssignmentIssue.start),
                            t(conditionAssignmentIssue.messageKey || 'validation.possiblyUnintendedAssignment', conditionAssignmentIssue.params || {}),
                            getWarningSeverity()
                        )
                    );
                }

                const startsWithLocalDecl = statement.firstKeyword === 'new' || statement.firstKeyword === 'static';
                let inlinePrefixForLine = null;
                const mayContainInlineLocalDeclAfterControl =
                    !startsWithLocalDecl &&
                    (
                        statement.firstKeyword === 'if' ||
                        statement.firstKeyword === 'for' ||
                        statement.firstKeyword === 'while' ||
                        statement.firstKeyword === 'do' ||
                        statement.firstKeyword === 'else'
                    ) &&
                    findKeywordOccurrences(structuralLine, ['new', 'static']).length > 0;
                let inlineLocalDeclAfterControl = false;
                if (mayContainInlineLocalDeclAfterControl) {
                    inlinePrefixForLine = stripLeadingInlineStatementPrefix(structuralLine);
                    inlineLocalDeclAfterControl =
                        hasControlInlinePrefix(inlinePrefixForLine) &&
                        inlinePrefixForLine.startOffset > 0 &&
                        isLocalDeclarationStatementStart(inlinePrefixForLine.text);
                }
                let previousLineControlLocalDecl = false;
                if (startsWithLocalDecl) {
                    const previousNonEmptyLine = findPreviousNonEmptyLine(lineNumber - 1);
                    if (previousNonEmptyLine >= 0) {
                        const previousTrimmedLine = String(strippedLines[previousNonEmptyLine] || '').trim();
                        const previousInlinePrefix = stripLeadingInlineStatementPrefix(previousTrimmedLine);
                        const previousStatement = classifyPawnStatementLine(previousTrimmedLine);
                        previousLineControlLocalDecl =
                            !isDoWhileClosingLine(previousNonEmptyLine) &&
                            (
                                previousStatement.firstKeyword === 'if' ||
                                previousStatement.firstKeyword === 'for' ||
                                previousStatement.firstKeyword === 'while' ||
                                previousStatement.firstKeyword === 'switch' ||
                                previousStatement.firstKeyword === 'do' ||
                                previousStatement.firstKeyword === 'else'
                            ) &&
                            !/[{;]\s*$/.test(previousTrimmedLine) &&
                            !String(previousInlinePrefix.text || '').trim();
                    }
                }
                if (
                    shouldIncludeTargetLine(targetLines, lineNumber) &&
                    (inlineLocalDeclAfterControl || (startsWithLocalDecl && (activeSingleStatementContext || previousLineControlLocalDecl)))
                ) {
                    const localDeclSource = inlinePrefixForLine?.text || trimmedLine;
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(
                                lineNumber,
                                isKeywordAt(localDeclSource.trimStart(), 0, 'static') ? 'static' : 'new'
                            ),
                            t('validation.localDeclarationMustAppearInCompoundBlock')
                        )
                    );
                    continue;
                }
            }

            if ((caseMatch || defaultMatch) && !activeSwitch && shouldIncludeTargetLine(targetLines, lineNumber)) {
                diagnostics.push(
                    createLiveValidationDiagnostic(
                        createKeywordRange(lineNumber, caseMatch ? 'case' : 'default', switchLabel.keywordStart),
                        t('validation.invalidStatementNotInSwitch')
                    )
                );
            }

            if (
                activeSwitch &&
                inlineCaseBody &&
                !inlineCaseBody.startsWith('{') &&
                countTopLevelSemicolonStatements(inlineCaseBody) > 1 &&
                shouldIncludeTargetLine(targetLines, lineNumber)
            ) {
                diagnostics.push(
                    createLiveValidationDiagnostic(
                        createKeywordRange(lineNumber, caseMatch ? 'case' : 'default', switchLabel.keywordStart),
                        t('validation.singleStatementAfterCase')
                    )
                );
            }

            if (activeBlockSwitch && currentDepth === activeBlockSwitch.bodyDepth) {
                if (caseMatch) {
                    if (activeBlockSwitch.seenDefault && shouldIncludeTargetLine(targetLines, lineNumber)) {
                        diagnostics.push(
                            createLiveValidationDiagnostic(
                                createKeywordRange(lineNumber, 'case', switchLabel.keywordStart),
                                t('validation.defaultMustBeLast')
                            )
                        );
                    }
                    const rawValue = stripTrailingSemicolon(caseMatch.label);
                    const resolvedCaseValues = resolveSwitchCaseLabelValues(rawValue, rootCtx.allDecls);
                    if (resolvedCaseValues.invalidRange && shouldIncludeTargetLine(targetLines, lineNumber)) {
                        diagnostics.push(
                            createLiveValidationDiagnostic(
                                createSwitchCaseLabelRange(lineNumber, caseMatch),
                                t('validation.invalidRange')
                            )
                        );
                    }
                    if (resolvedCaseValues.invalidConstant && shouldIncludeTargetLine(targetLines, lineNumber)) {
                        diagnostics.push(
                            createLiveValidationDiagnostic(
                                createSwitchCaseLabelRange(lineNumber, caseMatch),
                                t('validation.mustBeConstantExpression')
                            )
                        );
                    }
                    let duplicateValue = '';
                    for (const entry of resolvedCaseValues.entries) {
                        const duplicateEntryValue = findDuplicateSwitchCaseEntry(activeBlockSwitch, entry);
                        if (duplicateEntryValue && !duplicateValue) {
                            duplicateValue = duplicateEntryValue;
                        }
                        rememberSwitchCaseEntry(activeBlockSwitch, entry);
                    }
                    if (duplicateValue && shouldIncludeTargetLine(targetLines, lineNumber)) {
                        diagnostics.push(
                            createLiveValidationDiagnostic(
                                createSwitchCaseLabelRange(lineNumber, caseMatch),
                                t('validation.duplicateCaseLabel', { value: duplicateValue })
                            )
                        );
                    }
                } else if (defaultMatch) {
                    if (activeBlockSwitch.seenDefault) {
                        if (shouldIncludeTargetLine(targetLines, lineNumber)) {
                            diagnostics.push(
                                createLiveValidationDiagnostic(
                                    createKeywordRange(lineNumber, 'default', switchLabel.keywordStart),
                                    t('validation.multipleDefaultsInSwitch')
                                )
                            );
                        }
                    } else {
                        activeBlockSwitch.seenDefault = true;
                    }
                }
            }

            for (const controlMatch of statement.controlOccurrences) {
                const keyword = controlMatch.keyword;
                const isValid = keyword === 'break'
                    ? (hasActiveBreakContext || hasInlineContextBefore(structuralLine, controlMatch.start, keyword))
                    : (hasActiveLoop || hasInlineContextBefore(structuralLine, controlMatch.start, keyword));
                if (!isValid && shouldIncludeTargetLine(targetLines, lineNumber)) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createKeywordRange(lineNumber, keyword, controlMatch.start),
                            t('validation.outOfContextControl', { keyword })
                        )
                    );
                }
            }

            const functionBody = functionBodyRangeByLine[lineNumber] || null;
            if (functionBody) {
                updateFunctionTerminalState(lineNumber, functionBody, trimmedLine, statement);
            }
            if (functionBody && statement.firstKeyword === 'state') {
                const stateIssues = getStateStatementIssues(structuralLine, rootCtx.parsedDecls?.functions || []);
                for (const issue of stateIssues) {
                    if (!shouldIncludeTargetLine(targetLines, lineNumber)) continue;
                    const rangeStart = Number.isInteger(issue.rangeStart) ? issue.rangeStart : statement.firstKeywordStart;
                    const rangeEnd = Number.isInteger(issue.rangeEnd)
                        ? issue.rangeEnd
                        : rangeStart + Math.max(1, statement.firstKeyword.length);
                    const lineStartOffset = getLineStartOffset(lineNumber);
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createOffsetRange(document, lineStartOffset + rangeStart, lineStartOffset + rangeEnd, docLength),
                            t(issue.messageKey, issue.params || {})
                        )
                    );
                }
            }
            if (functionBody && statement.returnInfo) {
                    const funcKey = functionBody.func || null;
                    const state = returnStyleByFunction.get(funcKey) || {
                        sawVoid: false,
                        sawValue: false,
                        sawArray: false,
                        sawScalar: false,
                        valueReturnCount: 0,
                        firstValueReturn: null,
                        firstArrayReturnType: null,
                        firstArrayReturnDecls: null,
                        firstArrayReturnAnalysisCache: null
                    };
                    const returnValueText = statement.returnInfo.valueText;
                    const usesValue = !!returnValueText;
                    if (usesValue ? state.sawVoid : state.sawValue) {
                        if (shouldIncludeTargetLine(targetLines, lineNumber)) {
                            diagnostics.push(
                                createLiveValidationDiagnostic(
                                    createKeywordRange(lineNumber, 'return', statement.returnInfo.start),
                                    t('validation.mixedReturnStyles')
                                )
                            );
                        }
                    }
                    if (usesValue) {
                        const returnTypeInfo = getReturnValueTypeInfo(lineNumber, returnValueText);
                        const returnsArray = !!returnTypeInfo.type?.dims;
                        state.valueReturnCount++;
                        if (state.valueReturnCount === 1) {
                            state.firstValueReturn = {
                                lineNumber,
                                valueText: returnValueText
                            };
                            if (returnsArray) {
                                state.sawArray = true;
                                state.firstArrayReturnType = returnTypeInfo.type;
                                state.firstArrayReturnDecls = returnTypeInfo.decls;
                                state.firstArrayReturnAnalysisCache = returnTypeInfo.analysisCache;
                            } else {
                                state.sawScalar = true;
                            }
                        }
                        if (returnsArray ? state.sawScalar : state.sawArray) {
                            if (shouldIncludeTargetLine(targetLines, lineNumber)) {
                                diagnostics.push(
                                    createLiveValidationDiagnostic(
                                        createKeywordRange(lineNumber, 'return', statement.returnInfo.start),
                                        t('validation.inconsistentReturnTypesArrayNonArray')
                                    )
                                );
                            }
                        }
                        if (state.valueReturnCount > 1) {
                            if (returnsArray) {
                                if (state.firstArrayReturnType?.dims) {
                                    const shapeIssue = getLiveArrayShapeIssue(
                                        state.firstArrayReturnType.dims,
                                        returnTypeInfo.type.dims,
                                        returnValueText,
                                        state.firstArrayReturnDecls || returnTypeInfo.decls,
                                        state.firstArrayReturnAnalysisCache || returnTypeInfo.analysisCache,
                                        returnTypeInfo.escapeChar
                                    );
                                    if (shapeIssue && shouldIncludeTargetLine(targetLines, lineNumber)) {
                                        diagnostics.push(
                                            createLiveValidationDiagnostic(
                                                createKeywordRange(lineNumber, 'return', statement.returnInfo.start),
                                                explainArrayShapeDiagnosticIssue(shapeIssue).reason,
                                                shapeIssue.severity
                                            )
                                        );
                                    }
                                }
                                state.sawArray = true;
                                if (!state.firstArrayReturnType) {
                                    state.firstArrayReturnType = returnTypeInfo.type;
                                    state.firstArrayReturnDecls = returnTypeInfo.decls;
                                    state.firstArrayReturnAnalysisCache = returnTypeInfo.analysisCache;
                                }
                            } else {
                                state.sawScalar = true;
                            }
                        }
                    }
                    if (usesValue) state.sawValue = true;
                    else state.sawVoid = true;
                    returnStyleByFunction.set(funcKey, state);
            }

            const firstControlStartByType = new Map();
            for (const controlStart of statement.controlStarts) {
                if (!firstControlStartByType.has(controlStart.keyword)) {
                    firstControlStartByType.set(controlStart.keyword, controlStart.start);
                }
            }
            if (firstControlStartByType.has('switch')) {
                pushControlContext('switch', lineNumber, structuralLine, currentDepth, firstControlStartByType.get('switch'));
            }
            if (firstControlStartByType.has('for')) {
                pushControlContext('for', lineNumber, structuralLine, currentDepth, firstControlStartByType.get('for'));
            }
            if (firstControlStartByType.has('while') && !isDoWhileClosingLine(lineNumber)) {
                pushControlContext('while', lineNumber, structuralLine, currentDepth, firstControlStartByType.get('while'));
            }
            if (firstControlStartByType.has('do')) {
                pushControlContext('do', lineNumber, structuralLine, currentDepth, firstControlStartByType.get('do'));
            }

            for (const context of blockContexts) {
                if (context.braceBalance == null || lineNumber < (context.braceTrackingStartLine ?? context.startLine)) continue;
                context.braceBalance += countStructuralBraces(structuralLine);
            }
            while (
                blockContexts.length &&
                blockContexts[blockContexts.length - 1].braceBalance != null &&
                lineNumber >= (blockContexts[blockContexts.length - 1].braceTrackingStartLine ?? blockContexts[blockContexts.length - 1].startLine) &&
                blockContexts[blockContexts.length - 1].braceBalance <= 0
            ) {
                blockContexts.pop();
            }
        }

        if (areWarningDiagnosticsEnabled()) {
            for (const [func, returnState] of returnStyleByFunction) {
                if (!shouldIncludeTargetLine(targetLines, func.startLine ?? func.lineNumber ?? -1)) continue;
                const issue = getFunctionShouldReturnValueIssue(
                    func,
                    returnState,
                    hasCompilerLikeFunctionTerminal(func)
                        ? { hasFunctionLevelTerminal: true }
                        : (terminalStateByFunction.get(func) || null)
                );
                if (!issue) continue;
                diagnostics.push(
                    createLiveValidationDiagnostic(
                        createFunctionNameRange(func),
                        t(issue.messageKey || 'validation.functionShouldReturnValue', issue.params || { name: issue.name || func.name }),
                        getWarningSeverity()
                    )
                );
            }
            diagnostics.push(...collectUnreachableCodeDiagnostics());
        }
        return diagnostics;
    }

    return {
        collectStructuralLiveDiagnostics
    };
}

module.exports = { createStructuralDiagnostics };
