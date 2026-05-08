function createPreprocessorLabelSyntaxCore(deps) {
    const {
        getMacroRedefinitionIssue,
        getNestedCommentIssue,
        getInvalidRationalPrecisionIssue,
        collectDeclaredTagNames,
        collectTagOverrideParenthesesIssues,
        getFunctionBodyRangeByLine,
        getLabelDeclarationIssues,
        getRationalFormatAlreadyDefinedIssue,
        getSymbolTruncationIssue,
        collectRationalLiteralIssues,
        collectRationalLiteralPrecisionIssues,
        createRationalStateFromPragma,
        getUnknownPragmaIssue,
        ignoredUnknownSymbolNames = new Set(),
        isEnumMemberDeclarationLine,
        isFunctionHeaderLine,
        parseLabelDeclaration,
        parsePreprocessorDefineDirective,
        parsePreprocessorDirectiveLine,
        collectPreprocessorDirectiveText,
        parseRationalPragmaPayload,
        collectGotoReferences,
        analyzePreprocessorConditionExpression,
        getPreprocessorDirectiveIssues,
        maskStringLiteralContent,
        stripLeadingInlineStatementPrefix
    } = deps;

    function collectPreprocessorAndLabelIssues(rootCtx, targetLineNumbers = null, options = {}) {
        const issues = [];
        const includeWarnings = !!options.includeWarnings;
        const targetLines = targetLineNumbers instanceof Set ? targetLineNumbers : null;
        const shouldIncludeLine = lineNumber => !targetLines || targetLines.has(lineNumber);
        const rawLines = rootCtx.rawLines || rootCtx.text.split(/\r?\n/);
        const strippedLines = rootCtx.strippedLines || rawLines;
        const lineCtrlChars = rootCtx.lineCtrlChars || [];
        const scanLineNumbers = rootCtx.lineIndex.preprocessorAndLabelCandidateLines || [];
        const functionBodyRangeByLine = getFunctionBodyRangeByLine(rootCtx);
        const labelsByFunction = new Map();
        const globalLabels = new Set();
        const gotoRefs = [];
        const preprocessorStack = [];
        let rationalState = null;
        let includeEntryCursor = 0;
        let knownTagNames = null;
        const activeDefinesByName = new Map(
            (rootCtx.incDecls || [])
                .filter(decl => decl?.type === 'define' && decl.name)
                .map(decl => [decl.name, decl])
        );
        const labelDeclarationIssueCache = new Map();

        const pushIssue = (lineNumber, startIndex, length, messageKey, params = {}, severity = '') => {
            if (!messageKey || !shouldIncludeLine(lineNumber)) return;
            issues.push({
                lineNumber,
                startIndex: Math.max(0, startIndex),
                length: Math.max(1, length),
                messageKey,
                params,
                severity
            });
        };
        const pushWarningIssue = (lineNumber, startIndex, length, issue) => {
            if (!includeWarnings || !issue) return;
            pushIssue(
                lineNumber,
                startIndex,
                length,
                issue.messageKey,
                issue.params || {},
                issue.severity || 'warning'
            );
        };
        const collectNestedCommentIssues = () => {
            if (!includeWarnings) return;
            const relevantLines = rootCtx.lineIndex?.commentRelevantLines || [];
            if (!relevantLines.length) return;
            let relevantIndex = 0;
            let inBlockComment = false;

            for (let lineNumber = 0; lineNumber < rawLines.length; lineNumber++) {
                const isRelevant = relevantLines[relevantIndex] === lineNumber;
                if (!isRelevant && !inBlockComment) continue;
                if (isRelevant) relevantIndex++;

                const line = String(rawLines[lineNumber] || '');
                const escapeChar = lineCtrlChars[lineNumber] || '';
                let inString = false;
                let stringChar = '';
                for (let index = 0; index < line.length; index++) {
                    const char = line[index];
                    const next = line[index + 1] || '';
                    if (inBlockComment) {
                        if (char === '/' && next === '*') {
                            pushWarningIssue(
                                lineNumber,
                                index,
                                2,
                                typeof getNestedCommentIssue === 'function' ? getNestedCommentIssue() : null
                            );
                            index++;
                            continue;
                        }
                        if (char === '*' && next === '/') {
                            inBlockComment = false;
                            index++;
                        }
                        continue;
                    }
                    if (inString) {
                        if (char === stringChar && line[index - 1] !== escapeChar) {
                            inString = false;
                        }
                        continue;
                    }
                    if (char === '"' || char === "'") {
                        inString = true;
                        stringChar = char;
                        continue;
                    }
                    if (char === '/' && next === '/') break;
                    if (char === '/' && next === '*') {
                        inBlockComment = true;
                        index++;
                    }
                }
            }
        };
        const getFunctionKeyForLine = lineNumber => functionBodyRangeByLine[lineNumber]?.func || null;
        const addLabel = (functionKey, labelName) => {
            if (!labelName) return;
            if (!functionKey) {
                globalLabels.add(labelName);
                return;
            }
            let labels = labelsByFunction.get(functionKey);
            if (!labels) {
                labels = new Set();
                labelsByFunction.set(functionKey, labels);
            }
            labels.add(labelName);
        };
        const hasLabel = (functionKey, labelName) => {
            if (!labelName) return false;
            if (!functionKey) return globalLabels.has(labelName);
            return !!labelsByFunction.get(functionKey)?.has(labelName);
        };
        const getCachedLabelDeclarationIssues = labelName => {
            if (!labelName) return [];
            if (labelDeclarationIssueCache.has(labelName)) {
                return labelDeclarationIssueCache.get(labelName);
            }
            const result = getLabelDeclarationIssues(labelName, rootCtx.allDecls || []);
            labelDeclarationIssueCache.set(labelName, result);
            return result;
        };
        const isActivePreprocessorBranch = () =>
            !preprocessorStack.some(frame => frame?.active === false);
        const getKnownTagNames = () => {
            if (knownTagNames) return knownTagNames;
            knownTagNames = typeof collectDeclaredTagNames === 'function'
                ? collectDeclaredTagNames(rootCtx.allDecls || [])
                : new Set();
            const rationalTagName = String(rootCtx.preprocessedState?.rationalState?.tagName || '').trim();
            if (rationalTagName) knownTagNames.add(rationalTagName);
            return knownTagNames;
        };
        const pushTagOverrideParenthesesIssues = (lineNumber, structuralLine, activeBranch) => {
            if (!activeBranch || !includeWarnings || structuralLine.indexOf(':') < 0) return;
            if (typeof collectTagOverrideParenthesesIssues !== 'function') return;
            const tagIssues = collectTagOverrideParenthesesIssues(structuralLine, getKnownTagNames());
            for (const issue of tagIssues) {
                pushWarningIssue(
                    lineNumber,
                    issue.start,
                    Math.max(1, (issue.end ?? issue.start + 1) - issue.start),
                    issue
                );
            }
        };
        const readIncludeNameFromDirective = directive => {
            const payload = String(directive?.payload || '').trim();
            const opener = payload[0] || '';
            if (opener !== '<' && opener !== '"') return '';
            const closer = opener === '<' ? '>' : '"';
            const closeIndex = payload.indexOf(closer, 1);
            return closeIndex > 1 ? payload.slice(1, closeIndex).trim() : '';
        };
        const applyIncludeRationalState = directive => {
            const includeName = readIncludeNameFromDirective(directive);
            if (!includeName) return;
            const includeEntries = rootCtx.includeEntries || [];
            for (; includeEntryCursor < includeEntries.length; includeEntryCursor++) {
                const entry = includeEntries[includeEntryCursor];
                if ((entry?.depth | 0) !== 0) continue;
                if (String(entry.name || '') !== includeName) continue;
                includeEntryCursor++;
                if (entry.rationalState) rationalState = entry.rationalState;
                return;
            }
        };
        const pushRationalLiteralIssues = (lineNumber, structuralLine, activeBranch) => {
            if (!activeBranch || structuralLine.indexOf('.') < 0) return;
            const collectIssues = typeof collectRationalLiteralIssues === 'function'
                ? collectRationalLiteralIssues
                : (
                    rationalState && typeof collectRationalLiteralPrecisionIssues === 'function'
                        ? collectRationalLiteralPrecisionIssues
                        : null
                );
            if (!collectIssues) return;
            const literalIssues = collectIssues(structuralLine, rationalState);
            for (const issue of literalIssues) {
                if (issue.severity === 'warning') {
                    pushWarningIssue(
                        lineNumber,
                        issue.start,
                        Math.max(1, (issue.end ?? issue.start + 1) - issue.start),
                        issue
                    );
                    continue;
                }
                pushIssue(
                    lineNumber,
                    issue.start,
                    Math.max(1, (issue.end ?? issue.start + 1) - issue.start),
                    issue.messageKey,
                    issue.params || {},
                    issue.severity === 'warning' ? 'warning' : ''
                );
            }
        };
        const evaluatePreprocessorBranchCondition = directive => {
            if (!directive) return true;
            const payload = String(directive.payload || '').trim();
            if (directive.keyword === 'ifdef' || directive.keyword === 'ifndef') {
                const name = payload.match(/^([A-Za-z_@]\w*)/)?.[1] || '';
                const isDefined = !!(name && activeDefinesByName.has(name));
                return directive.keyword === 'ifdef' ? isDefined : !isDefined;
            }
            if (typeof analyzePreprocessorConditionExpression !== 'function') return true;
            const analysis = analyzePreprocessorConditionExpression(payload, [], activeDefinesByName);
            return analysis.valid ? !!analysis.value : true;
        };
        const pushPreprocessorBranchFrame = directive => {
            const parentActive = isActivePreprocessorBranch();
            const branchValue = evaluatePreprocessorBranchCondition(directive);
            const active = parentActive && branchValue;
            preprocessorStack.push({
                lineNumber: directive.keywordStart >= 0 ? directive.lineNumber ?? -1 : -1,
                hasElse: false,
                parentActive,
                active,
                branchTaken: active
            });
        };
        const updatePreprocessorElseBranch = frame => {
            if (!frame) return;
            frame.hasElse = true;
            frame.active = !!(frame.parentActive && !frame.branchTaken);
            frame.branchTaken = true;
        };
        const updatePreprocessorElseIfBranch = (frame, directive) => {
            if (!frame) return;
            const branchValue = evaluatePreprocessorBranchCondition(directive);
            frame.active = !!(frame.parentActive && !frame.branchTaken && branchValue);
            if (frame.active) frame.branchTaken = true;
        };
        const findLabelDeclaration = (lineNumber, sourceLine) => {
            const findAtStatementStart = source => {
                const parsed = typeof parseLabelDeclaration === 'function'
                    ? parseLabelDeclaration(source)
                    : null;
                if (!parsed) return null;
                return ignoredUnknownSymbolNames.has(parsed.name)
                    ? null
                    : {
                        name: parsed.name,
                        nameIndex: parsed.nameIndex,
                        endOffset: parsed.endOffset
                    };
            };

            const sourceText = String(sourceLine || '');
            const directLabel = findAtStatementStart(sourceText);
            if (directLabel && !sourceText.slice(directLabel.endOffset).trim()) {
                return directLabel;
            }
            if (!functionBodyRangeByLine[lineNumber]) return null;
            if (isFunctionHeaderLine(rootCtx, lineNumber)) return null;
            if (isEnumMemberDeclarationLine(rootCtx, lineNumber)) return null;

            if (directLabel) return directLabel;

            const inlineStatement = stripLeadingInlineStatementPrefix(sourceLine);
            const inlineLabel = inlineStatement.startOffset > 0
                ? findAtStatementStart(inlineStatement.text)
                : null;
            return inlineLabel
                ? {
                    ...inlineLabel,
                    nameIndex: inlineStatement.startOffset + inlineLabel.nameIndex
                }
                : null;
        };

        const processPreprocessorAndLabelLine = lineNumber => {
            const escapeChar = lineCtrlChars[lineNumber] || '';
            const lineText = String(strippedLines[lineNumber] || '');
            const structuralLine = maskStringLiteralContent(lineText, escapeChar);
            const trimmedLine = structuralLine.trim();
            if (!trimmedLine) return;
            const activeBranchAtLineStart = isActivePreprocessorBranch();
            pushTagOverrideParenthesesIssues(lineNumber, structuralLine, activeBranchAtLineStart);

            const labelDecl = findLabelDeclaration(lineNumber, structuralLine);
            addLabel(getFunctionKeyForLine(lineNumber), labelDecl?.name || '');
            if (labelDecl?.name) {
                for (const issue of getCachedLabelDeclarationIssues(labelDecl.name)) {
                    pushIssue(
                        lineNumber,
                        labelDecl.nameIndex,
                        labelDecl.name.length,
                        issue.messageKey,
                        { name: issue.name || labelDecl.name },
                        issue.severity === 'warning' ? 'warning' : ''
                    );
                }
            }

            const gotoReferences = typeof collectGotoReferences === 'function'
                ? collectGotoReferences(structuralLine)
                : [];
            const gotoFunctionKey = getFunctionKeyForLine(lineNumber);
            for (const gotoRef of gotoReferences) {
                if (!gotoFunctionKey) continue;
                if (gotoRef.issue) {
                    pushIssue(
                        lineNumber,
                        gotoRef.labelIndex,
                        Math.max(1, (gotoRef.labelEnd ?? gotoRef.labelIndex + 1) - gotoRef.labelIndex),
                        gotoRef.issue.messageKey,
                        gotoRef.issue.params || {}
                    );
                    continue;
                }
                gotoRefs.push({
                    lineNumber,
                    labelName: gotoRef.labelName,
                    labelIndex: gotoRef.labelIndex,
                    functionKey: gotoFunctionKey
                });
            }

            if (trimmedLine[0] !== '#') {
                pushRationalLiteralIssues(lineNumber, structuralLine, activeBranchAtLineStart);
                return;
            }

            const directiveSource = typeof collectPreprocessorDirectiveText === 'function'
                ? collectPreprocessorDirectiveText(rawLines, lineNumber, strippedLines)
                : { text: structuralLine, nextLine: lineNumber + 1, mapRange: rangeStart => ({ lineNumber, start: rangeStart, length: 1 }) };
            const directive = parsePreprocessorDirectiveLine(directiveSource.text, {
                escapeChar,
                stripLineComment: true
            });
            if (!directive) {
                pushRationalLiteralIssues(lineNumber, structuralLine, activeBranchAtLineStart);
                return;
            }
            directive.lineNumber = lineNumber;
            const directiveName = directive.keyword;
            const directiveIndex = directive.keywordStart;
            const activeBranch = activeBranchAtLineStart;

            const directiveIssues = getPreprocessorDirectiveIssues(
                directive,
                rootCtx.allDecls || [],
                {
                    defineLookup: activeDefinesByName,
                    activeBranch
                }
            );
            for (const issue of directiveIssues) {
                const mappedRange = typeof directiveSource.mapRange === 'function'
                    ? directiveSource.mapRange(issue.range.start, issue.range.length)
                    : { lineNumber, start: issue.range.start, length: issue.range.length };
                pushIssue(
                    mappedRange.lineNumber,
                    mappedRange.start,
                    mappedRange.length,
                    issue.messageKey,
                    issue.params || {},
                    issue.severity === 'warning' ? 'warning' : ''
                );
            }
            if (directiveIssues.some(issue => issue.messageKey === 'validation.unknownDirective')) {
                return;
            }

            if (directiveName === 'define' && directiveIssues.some(issue => issue.messageKey === 'validation.definePatternMustStartWithAlphabeticCharacter')) {
                return;
            }

            if (directiveName === 'pragma') {
                const pragmaPayload = String(directive.payload || '');
                const pragmaName = pragmaPayload.trim().match(/^([A-Za-z_@]\w*)/)?.[1] || '';
                const pragmaOffset = pragmaName ? pragmaPayload.indexOf(pragmaName) : 0;
                if (pragmaName.toLowerCase() === 'rational') {
                    const parsedRational = typeof parseRationalPragmaPayload === 'function'
                        ? parseRationalPragmaPayload(
                            pragmaPayload.slice(pragmaOffset + pragmaName.length),
                            [...activeDefinesByName.values()]
                        )
                        : null;
                    if (activeBranch && parsedRational) {
                        const precisionIssue = typeof getInvalidRationalPrecisionIssue === 'function'
                            ? getInvalidRationalPrecisionIssue(parsedRational)
                            : null;
                        if (precisionIssue) {
                            pushIssue(
                                lineNumber,
                                directive.payloadStart + pragmaOffset + pragmaName.length + parsedRational.precisionStart,
                                Math.max(1, parsedRational.precisionEnd - parsedRational.precisionStart),
                                precisionIssue.messageKey,
                                precisionIssue.params || {},
                                precisionIssue.severity === 'warning' ? 'warning' : ''
                            );
                        }
                        const nextRationalState = typeof createRationalStateFromPragma === 'function'
                            ? createRationalStateFromPragma(parsedRational)
                            : null;
                        const duplicateIssue = typeof getRationalFormatAlreadyDefinedIssue === 'function'
                            ? getRationalFormatAlreadyDefinedIssue(rationalState, nextRationalState)
                            : null;
                        if (duplicateIssue) {
                            pushIssue(
                                lineNumber,
                                directive.payloadStart,
                                Math.max(1, directive.payloadEnd - directive.payloadStart),
                                duplicateIssue.messageKey,
                                duplicateIssue.params || {},
                                duplicateIssue.severity === 'warning' ? 'warning' : ''
                            );
                        } else if (nextRationalState) {
                            rationalState = nextRationalState;
                        }
                    }
                    return;
                }
                const issue = typeof getUnknownPragmaIssue === 'function'
                    ? getUnknownPragmaIssue(pragmaName)
                    : null;
                if (activeBranch) {
                    pushWarningIssue(
                        lineNumber,
                        pragmaName ? directive.payloadStart + pragmaOffset : directive.keywordStart,
                        Math.max(1, pragmaName.length || directive.keywordRaw.length),
                        issue
                    );
                }
                return;
            }

            if (directiveName === 'define') {
                const parsed = typeof parsePreprocessorDefineDirective === 'function'
                    ? parsePreprocessorDefineDirective(directive)
                    : null;
                if (parsed?.valid && parsed.name) {
                    const currentDefine = {
                        type: 'define',
                        name: parsed.name,
                        args: parsed.args,
                        macroStyle: parsed.macroStyle,
                        macroIndexer: parsed.macroIndexer,
                        value: parsed.value
                    };
                    if (activeBranch) {
                        pushWarningIssue(
                            lineNumber,
                            parsed.nameStart,
                            Math.max(1, parsed.nameEnd - parsed.nameStart),
                            typeof getSymbolTruncationIssue === 'function'
                                ? getSymbolTruncationIssue(parsed.name)
                                : null
                        );
                        pushWarningIssue(
                            lineNumber,
                            parsed.nameStart,
                            Math.max(1, parsed.nameEnd - parsed.nameStart),
                            typeof getMacroRedefinitionIssue === 'function'
                                ? getMacroRedefinitionIssue(activeDefinesByName.get(parsed.name) || null, currentDefine)
                                : null
                        );
                        activeDefinesByName.set(parsed.name, currentDefine);
                    }
                }
                return;
            }

            if (directiveName === 'undef') {
                const undefName = String(directive.payload || '').trim().match(/^([A-Za-z_@]\w*)/)?.[1] || '';
                if (activeBranch && undefName) activeDefinesByName.delete(undefName);
                return;
            }

            if (directiveName === 'include' || directiveName === 'tryinclude') {
                if (activeBranch) applyIncludeRationalState(directive);
                return;
            }

            if (directiveName === 'if' || directiveName === 'ifdef' || directiveName === 'ifndef') {
                if (directiveName === 'if') {
                    pushRationalLiteralIssues(lineNumber, structuralLine, activeBranchAtLineStart);
                }
                pushPreprocessorBranchFrame(directive);
                return;
            }
            if (directiveName === 'else') {
                const frame = preprocessorStack[preprocessorStack.length - 1] || null;
                if (!frame) {
                    pushIssue(lineNumber, directiveIndex, directiveName.length, 'validation.noMatchingIf');
                } else if (frame.hasElse) {
                    pushIssue(lineNumber, directiveIndex, directiveName.length, 'validation.multipleElseDirectives');
                } else {
                    updatePreprocessorElseBranch(frame);
                }
                return;
            }
            if (directiveName === 'elseif' || directiveName === 'elif') {
                const frame = preprocessorStack[preprocessorStack.length - 1] || null;
                pushRationalLiteralIssues(lineNumber, structuralLine, frame?.parentActive !== false);
                if (!frame) {
                    pushIssue(lineNumber, directiveIndex, directiveName.length, 'validation.noMatchingIf');
                } else if (frame.hasElse) {
                    pushIssue(lineNumber, directiveIndex, directiveName.length, 'validation.elseifAfterElse');
                } else {
                    updatePreprocessorElseIfBranch(frame, directive);
                }
                return;
            }
            if (directiveName === 'endif') {
                if (!preprocessorStack.length) {
                    pushIssue(lineNumber, directiveIndex, directiveName.length, 'validation.noMatchingIf');
                } else {
                    preprocessorStack.pop();
                }
            }
        };

        for (const lineNumber of scanLineNumbers) {
            if (lineNumber >= 0 && lineNumber < strippedLines.length) {
                processPreprocessorAndLabelLine(lineNumber);
            }
        }
        collectNestedCommentIssues();

        for (const gotoRef of gotoRefs) {
            if (hasLabel(gotoRef.functionKey, gotoRef.labelName)) continue;
            pushIssue(
                gotoRef.lineNumber,
                gotoRef.labelIndex,
                gotoRef.labelName.length,
                'validation.notALabel',
                { name: gotoRef.labelName }
            );
        }

        for (const frame of preprocessorStack) {
            if (!shouldIncludeLine(frame.lineNumber)) continue;
            const lineText = String(strippedLines[frame.lineNumber] || '');
            const directiveIndex = lineText.indexOf('if');
            pushIssue(
                frame.lineNumber,
                directiveIndex >= 0 ? directiveIndex : 0,
                2,
                'validation.noMatchingIf'
            );
        }

        return issues;
    }

    return {
        collectPreprocessorAndLabelIssues
    };
}

module.exports = { createPreprocessorLabelSyntaxCore };
