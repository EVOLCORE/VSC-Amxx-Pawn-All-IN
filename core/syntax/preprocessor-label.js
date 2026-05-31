const { isPreprocessorDirectiveLine } = require('./preprocessor-lines');
const { readPreprocessorIdentifierToken } = require('./preprocessor-directive-context');
const { parsePawnIncludeDirectiveTarget } = require('./includes');
const { readPawnIdentifierAt } = require('./identifiers');
const { splitPawnLines } = require('./lines');

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
        stripLeadingInlineStatementPrefix,
        collectEnumMemberSyntaxIssues
    } = deps;

    function collectPreprocessorAndLabelIssues(rootCtx, targetLineNumbers = null, options = {}) {
        const issues = [];
        const includeWarnings = !!options.includeWarnings;
        const targetLines = targetLineNumbers instanceof Set ? targetLineNumbers : null;
        const shouldIncludeLine = lineNumber => !targetLines || targetLines.has(lineNumber);
        const rawLines = rootCtx.rawLines || splitPawnLines(rootCtx.text);
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
        const unresolvedRequiredIncludes = (rootCtx.preprocessedState?.unresolvedIncludeEntries || [])
            .filter(entry => entry?.required !== false);
        const hasUnresolvedRequiredIncludes = unresolvedRequiredIncludes.length > 0;
        const unresolvedRequiredIncludeByLineAndName = new Map();
        const unresolvedIncludeDependenciesByParentLineAndName = new Map();
        for (const entry of unresolvedRequiredIncludes) {
            if (!entry?.name) continue;
            if ((entry.depth | 0) === 0 && Number.isInteger(entry.lineNumber) && entry.lineNumber >= 0) {
                const key = `${entry.lineNumber}|${entry.name}`;
                if (!unresolvedRequiredIncludeByLineAndName.has(key)) {
                    unresolvedRequiredIncludeByLineAndName.set(key, entry);
                }
            }
            if (Number.isInteger(entry.parentLineNumber) && entry.parentLineNumber >= 0 && entry.parentName) {
                const parentKey = `${entry.parentLineNumber}|${entry.parentName}`;
                const existing = unresolvedIncludeDependenciesByParentLineAndName.get(parentKey);
                if (existing) {
                    if (!existing.some(item => item?.name === entry.name)) existing.push(entry);
                } else {
                    unresolvedIncludeDependenciesByParentLineAndName.set(parentKey, [entry]);
                }
            }
        }
        const activeDefinesByName = new Map();
        for (const decl of rootCtx.incDecls || []) {
            if (decl?.type === 'define' && decl.name) {
                activeDefinesByName.set(decl.name, decl);
            }
        }
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
                                getNestedCommentIssue()
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
            const result = getLabelDeclarationIssues(labelName, getKnownTagNames());
            labelDeclarationIssueCache.set(labelName, result);
            return result;
        };
        const isActivePreprocessorBranch = () =>
            !preprocessorStack.some(frame => frame?.active === false);
        const getKnownTagNames = () => {
            if (knownTagNames) return knownTagNames;
            knownTagNames = collectDeclaredTagNames(rootCtx.allDecls || []);
            const rationalTagName = String(rootCtx.preprocessedState?.rationalState?.tagName || '').trim();
            if (rationalTagName) knownTagNames.add(rationalTagName);
            return knownTagNames;
        };
        const pushTagOverrideParenthesesIssues = (lineNumber, structuralLine, activeBranch) => {
            if (!activeBranch || !includeWarnings || structuralLine.indexOf(':') < 0) return;
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
        const readIncludeRequestFromDirective = directive => {
            const parsed = parsePawnIncludeDirectiveTarget(directive?.directiveLine || '');
            const name = parsed?.name || '';
            if (!parsed || !name) return null;
            return {
                name,
                startIndex: parsed.nameStart,
                length: Math.max(1, parsed.nameEnd - parsed.nameStart)
            };
        };
        const readIncludeNameFromDirective = directive => {
            return readIncludeRequestFromDirective(directive)?.name || '';
        };
        const applyIncludeRationalState = directive => {
            const includeName = readIncludeNameFromDirective(directive);
            if (!includeName) return false;
            const includeEntries = rootCtx.includeEntries || [];
            const sourceLineNumber = directive.lineNumber;
            if (Number.isInteger(sourceLineNumber)) {
                const lineEntryIndex = includeEntries.findIndex((entry, index) =>
                    index >= includeEntryCursor &&
                    (entry?.depth | 0) === 0 &&
                    entry.lineNumber === sourceLineNumber &&
                    String(entry.name || '') === includeName
                );
                if (lineEntryIndex >= 0) {
                    includeEntryCursor = lineEntryIndex + 1;
                    const entry = includeEntries[lineEntryIndex];
                    if (entry.rationalState) rationalState = entry.rationalState;
                    return true;
                }
            }
            for (; includeEntryCursor < includeEntries.length; includeEntryCursor++) {
                const entry = includeEntries[includeEntryCursor];
                if ((entry?.depth | 0) !== 0) continue;
                if (String(entry.name || '') !== includeName) continue;
                includeEntryCursor++;
                if (entry.rationalState) rationalState = entry.rationalState;
                return true;
            }
            return false;
        };
        const pushRationalLiteralIssues = (lineNumber, structuralLine, activeBranch) => {
            if (hasUnresolvedRequiredIncludes) return;
            if (!activeBranch || structuralLine.indexOf('.') < 0) return;
            const literalIssues = collectRationalLiteralIssues(structuralLine, rationalState);
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
                const name = readPawnIdentifierAt(payload, 0)?.name || '';
                const analysis = name
                    ? analyzePreprocessorConditionExpression(`defined ${name}`, [], activeDefinesByName, {
                        lineNumber: directive.lineNumber
                    })
                    : null;
                const isDefined = analysis?.valid ? !!analysis.value : !!(name && activeDefinesByName.has(name));
                return directive.keyword === 'ifdef' ? isDefined : !isDefined;
            }
            const analysis = analyzePreprocessorConditionExpression(payload, [], activeDefinesByName, {
                lineNumber: directive.lineNumber
            });
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
                const parsed = parseLabelDeclaration(source);
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

            const gotoReferences = collectGotoReferences(structuralLine);
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

            if (!isPreprocessorDirectiveLine(trimmedLine)) {
                pushRationalLiteralIssues(lineNumber, structuralLine, activeBranchAtLineStart);
                return;
            }

            const directiveSource = collectPreprocessorDirectiveText(rawLines, lineNumber, strippedLines, false);
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
            let mappedDirectiveSource = null;
            const mapDirectiveRange = range => {
                if (!directiveSource.continued) {
                    return directiveSource.mapRange(range.start, range.length);
                }
                if (!mappedDirectiveSource) {
                    mappedDirectiveSource = collectPreprocessorDirectiveText(rawLines, lineNumber, strippedLines, true);
                }
                return mappedDirectiveSource.mapRange(range.start, range.length);
            };
            for (const issue of directiveIssues) {
                const mappedRange = mapDirectiveRange(issue.range);
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
                const pragmaToken = readPreprocessorIdentifierToken(pragmaPayload, 0);
                const pragmaName = pragmaToken?.name || '';
                const pragmaOffset = pragmaToken?.start ?? 0;
                if (pragmaName.toLowerCase() === 'rational') {
                    const parsedRational = parseRationalPragmaPayload(
                        pragmaPayload.slice((pragmaToken?.end ?? pragmaOffset) || 0),
                        [...activeDefinesByName.values()]
                    );
                    if (activeBranch && parsedRational) {
                        const precisionIssue = getInvalidRationalPrecisionIssue(parsedRational);
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
                        const nextRationalState = createRationalStateFromPragma(parsedRational);
                        const duplicateIssue = getRationalFormatAlreadyDefinedIssue(rationalState, nextRationalState);
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
                const issue = getUnknownPragmaIssue(pragmaName);
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
                const parsed = parsePreprocessorDefineDirective(directive);
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
                            getSymbolTruncationIssue(parsed.name)
                        );
                        pushWarningIssue(
                            lineNumber,
                            parsed.nameStart,
                            Math.max(1, parsed.nameEnd - parsed.nameStart),
                            getMacroRedefinitionIssue(activeDefinesByName.get(parsed.name) || null, currentDefine)
                        );
                        activeDefinesByName.set(parsed.name, currentDefine);
                    }
                }
                return;
            }

            if (directiveName === 'undef') {
                const undefName = readPreprocessorIdentifierToken(String(directive.payload || ''), 0)?.name || '';
                if (activeBranch && undefName) activeDefinesByName.delete(undefName);
                return;
            }

            if (directiveName === 'include' || directiveName === 'tryinclude') {
                if (activeBranch) applyIncludeRationalState(directive);
                if (activeBranch && directiveName === 'include') {
                    const includeRequest = readIncludeRequestFromDirective(directive);
                    const unresolvedEntry = includeRequest
                        ? unresolvedRequiredIncludeByLineAndName.get(`${lineNumber}|${includeRequest.name}`)
                        : null;
                    if (unresolvedEntry && includeRequest) {
                        pushIssue(
                            lineNumber,
                            includeRequest.startIndex,
                            includeRequest.length,
                            'validation.includeNotResolved',
                            { name: includeRequest.name }
                        );
                    } else if (includeRequest) {
                        const unresolvedDependencies = unresolvedIncludeDependenciesByParentLineAndName.get(`${lineNumber}|${includeRequest.name}`) || [];
                        for (const unresolvedDependency of unresolvedDependencies) {
                            pushIssue(
                                lineNumber,
                                includeRequest.startIndex,
                                includeRequest.length,
                                'validation.includeDependencyNotResolved',
                                {
                                    name: unresolvedDependency.name,
                                    parentName: includeRequest.name
                                }
                            );
                        }
                    }
                }
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
        for (const issue of collectEnumMemberSyntaxIssues(rawLines, strippedLines, lineCtrlChars, targetLines)) {
            pushIssue(
                issue.lineNumber,
                issue.startIndex,
                issue.length,
                issue.messageKey,
                issue.params || {},
                issue.severity || ''
            );
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
