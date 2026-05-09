function createSymbolDiagnostics(deps) {
    const {
        areWarningDiagnosticsEnabled,
        createLiveValidationDiagnostic,
        createOffsetRange,
        findDocumentVariableDeclByName,
        findFirstNonWhitespaceIndex,
        findPreviousNonWhitespaceIndex,
        findUnresolvedReferenceNames,
        findVariableDeclarationSpanInRange,
        getMultilineStringLineFlags,
        getSymbolTruncationIssue,
        getWarningSeverity,
        ignoredUnknownSymbolNames,
        isEnumMemberDeclarationLine,
        isEscapedQuote,
        isFunctionHeaderLine,
        isFunctionLikeLookupDecl,
        isHexLiteralIdentifierTail,
        isIdentifierContinueChar,
        isIdentifierStartChar,
        isIncludeDocument,
        isObjectAliasDefineLookupDecl,
        isStrictIncludeValidationEnabled,
        looksLikePawnExpressionFragment,
        nonAsciiCharRe,
        parseLabelDeclaration,
        parseStateStatement,
        t
    } = deps;
    function collectUnknownSymbolLiveDiagnosticsForLine(document, lineNumber, ctx, analysisCacheOrFactory, lineText, strippedLineText, lineStartOffset, docLength, declarationSourceState = null, lookupState = null) {
        const diagnostics = [];
        if (isIncludeDocument(document) && !isStrictIncludeValidationEnabled()) return diagnostics;
        if (!/[A-Za-z_@]/.test(lineText) && !nonAsciiCharRe.test(lineText)) return diagnostics;
        const multilineStringLineFlags = getMultilineStringLineFlags(ctx);
        if (multilineStringLineFlags[lineNumber]) return diagnostics;
        const getAnalysisCache = () => (
            typeof analysisCacheOrFactory === 'function'
                ? analysisCacheOrFactory()
                : analysisCacheOrFactory
        );

        const trimmedLine = String(strippedLineText || lineText || '').trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) return diagnostics;

        if (isFunctionHeaderLine(ctx, lineNumber)) return diagnostics;
        if (isEnumMemberDeclarationLine(ctx, lineNumber)) return diagnostics;

        const getLookupScopedCaches = () => {
            if (!lookupState || !ctx?.lookup) return null;
            let scoped = lookupState.byLookup?.get(ctx.lookup);
            if (!scoped) {
                scoped = {
                    anyDeclByNameCache: new Map(),
                    functionLikeDeclByNameCache: new Map(),
                    objectAliasDefineByNameCache: new Map()
                };
                if (!lookupState.byLookup) lookupState.byLookup = new WeakMap();
                lookupState.byLookup.set(ctx.lookup, scoped);
            }
            return scoped;
        };
        const lookupScopedCaches = getLookupScopedCaches();
        const anyDeclByNameCache = lookupScopedCaches?.anyDeclByNameCache || new Map();
        const functionLikeDeclByNameCache = lookupScopedCaches?.functionLikeDeclByNameCache || new Map();
        const objectAliasDefineByNameCache = lookupScopedCaches?.objectAliasDefineByNameCache || new Map();
        const findAnyDeclByName = name => {
            if (anyDeclByNameCache.has(name)) return anyDeclByNameCache.get(name);
            const decl = ctx.lookup.findAnyDeclByName(name) || null;
            anyDeclByNameCache.set(name, decl);
            return decl;
        };
        const findFunctionLikeDeclByName = name => {
            if (functionLikeDeclByNameCache.has(name)) return functionLikeDeclByNameCache.get(name);
            const decl = ctx.lookup.findAnyDeclByName(name, isFunctionLikeLookupDecl) || null;
            functionLikeDeclByNameCache.set(name, decl);
            return decl;
        };
        const findObjectAliasDefineByName = name => {
            if (objectAliasDefineByNameCache.has(name)) return objectAliasDefineByNameCache.get(name);
            const decl = ctx.lookup.findAnyDeclByName(name, isObjectAliasDefineLookupDecl) || null;
            objectAliasDefineByNameCache.set(name, decl);
            return decl;
        };
        const seen = new Set();
        const escapeChar = ctx.resolver.ctrlCharAtLine(lineNumber);
        const rawLineText = String(lineText || '');
        const strippedScanText = String(strippedLineText || rawLineText);
        const canTrustStrippedScan = strippedScanText.length === rawLineText.length;
        const identifierScanText = canTrustStrippedScan ? strippedScanText : rawLineText;
        const bareIdentifierMatch = trimmedLine.match(/^([A-Za-z_@][A-Za-z0-9_@]*)$/);
        const stateStatement = parseStateStatement(strippedLineText || lineText);
        const isStateStatementSyntaxName = (start, end) => !!(
            stateStatement &&
            (
                (start >= stateStatement.keywordStart && end <= stateStatement.keywordEnd) ||
                (stateStatement.automatonStart >= 0 && start >= stateStatement.automatonStart && end <= stateStatement.automatonEnd) ||
                (stateStatement.stateStart >= 0 && start >= stateStatement.stateStart && end <= stateStatement.stateEnd)
            )
        );
        const pushSymbolTruncationWarning = (name, start, end) => {
            if (!areWarningDiagnosticsEnabled()) return false;
            const issue = getSymbolTruncationIssue(name);
            if (!issue) return false;
            const key = `truncated:${start}:${end}:${name}`;
            if (seen.has(key)) return true;
            seen.add(key);
            diagnostics.push(
                createLiveValidationDiagnostic(
                    createOffsetRange(document, lineStartOffset + start, lineStartOffset + end, docLength),
                    t(issue.messageKey, issue.params || {}),
                    getWarningSeverity()
                )
            );
            return true;
        };

        if (bareIdentifierMatch && !ignoredUnknownSymbolNames.has(bareIdentifierMatch[1])) {
            const startIndex = lineText.indexOf(bareIdentifierMatch[1]);
            if (startIndex >= 0) {
                pushSymbolTruncationWarning(
                    bareIdentifierMatch[1],
                    startIndex,
                    startIndex + bareIdentifierMatch[1].length
                );
            }
            if (!findAnyDeclByName(bareIdentifierMatch[1])) {
                const analysisCache = getAnalysisCache();
                const unresolved = findUnresolvedReferenceNames(
                    bareIdentifierMatch[1],
                    analysisCache ? [] : ctx.allDecls,
                    analysisCache,
                    escapeChar
                );
                if (!unresolved.length) {
                    return diagnostics;
                }
                if (startIndex >= 0) {
                    diagnostics.push(
                        createLiveValidationDiagnostic(
                            createOffsetRange(
                                document,
                                lineStartOffset + startIndex,
                                lineStartOffset + startIndex + bareIdentifierMatch[1].length,
                                docLength
                            ),
                            t('validation.unknownSymbol', { symbols: unresolved.length ? unresolved.join(', ') : bareIdentifierMatch[1] })
                        )
                    );
                    return diagnostics;
                }
            }
        }

        const findPreviousWordBefore = index => {
            let cursor = findPreviousNonWhitespaceIndex(identifierScanText, index - 1);
            if (cursor < 0) return '';
            let end = cursor + 1;
            while (cursor >= 0 && isIdentifierContinueChar(identifierScanText[cursor])) {
                cursor--;
            }
            const start = cursor + 1;
            if (start >= end) return '';
            return identifierScanText.slice(start, end);
        };

        let inStr = false;
        let strCh = '';
        let lineComment = false;
        let blockComment = false;
        for (let index = 0; index < identifierScanText.length; index++) {
            const char = identifierScanText[index];

            if (!canTrustStrippedScan) {
                if (blockComment) {
                    if (char === '*' && identifierScanText[index + 1] === '/') {
                        blockComment = false;
                        index++;
                    }
                    continue;
                }
                if (lineComment) break;
            }
            if (inStr) {
                if (char === strCh && !isEscapedQuote(identifierScanText, index, escapeChar)) {
                    inStr = false;
                }
                continue;
            }
            if (!canTrustStrippedScan) {
                if (char === '/' && identifierScanText[index + 1] === '/') {
                    lineComment = true;
                    continue;
                }
                if (char === '/' && identifierScanText[index + 1] === '*') {
                    blockComment = true;
                    index++;
                    continue;
                }
            }
            if (char === '"' || char === "'") {
                inStr = true;
                strCh = char;
                continue;
            }
            if (!isIdentifierStartChar(char)) continue;
            if (index > 0 && isIdentifierContinueChar(identifierScanText[index - 1])) continue;
            if (isHexLiteralIdentifierTail(identifierScanText, index)) continue;

            const start = index;
            let end = index + 1;
            while (end < identifierScanText.length && isIdentifierContinueChar(identifierScanText[end])) end++;
            const name = identifierScanText.slice(start, end);
            index = end - 1;

            if (ignoredUnknownSymbolNames.has(name)) continue;
            if (isStateStatementSyntaxName(start, end)) continue;
            pushSymbolTruncationWarning(name, start, end);

            const prevIndex = findPreviousNonWhitespaceIndex(identifierScanText, start - 1);
            const nextIndex = findFirstNonWhitespaceIndex(identifierScanText, end);
            const prevChar = prevIndex >= 0 ? identifierScanText[prevIndex] : '';
            const nextChar = nextIndex >= 0 ? identifierScanText[nextIndex] : '';
            const previousWord = findPreviousWordBefore(start);
            if (nextChar === ':') continue;
            if (prevChar === '.' && nextChar === '=') continue;
            if (previousWord === 'goto') continue;

            if (nextChar === '(') {
                const isKnownFunction = !!findFunctionLikeDeclByName(name);
                const aliasDefine = isKnownFunction
                    ? null
                    : findObjectAliasDefineByName(name);
                const aliasTargetName = String(aliasDefine?.value || '').trim().match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
                const isKnownFunctionAlias = !!(
                    aliasTargetName &&
                    findFunctionLikeDeclByName(aliasTargetName)
                );
                if (isKnownFunction || isKnownFunctionAlias) continue;
                if (findAnyDeclByName(name)) continue;
                if (isIncludeDocument(document)) continue;
                // Function-call unknowns are emitted by collectCallLiveDiagnostics().
                continue;
            }

            const knownDecl = findAnyDeclByName(name);
            if (knownDecl) continue;
            const absoluteStart = lineStartOffset + start;
            const absoluteEnd = lineStartOffset + end;
            const declarationVariableDecl = findDocumentVariableDeclByName(ctx, name, lineNumber);
            if (declarationVariableDecl && findVariableDeclarationSpanInRange(
                document,
                absoluteStart,
                absoluteEnd,
                declarationVariableDecl,
                ctx.resolver,
                ctx.text,
                declarationSourceState,
                name,
                lineNumber,
                lineNumber
            )) {
                continue;
            }
            const analysisCache = getAnalysisCache();
            const unresolved = findUnresolvedReferenceNames(
                name,
                analysisCache ? [] : ctx.allDecls,
                analysisCache,
                escapeChar
            );
            if (!unresolved.length) continue;

            const key = `${start}:${end}:${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            diagnostics.push(
                createLiveValidationDiagnostic(
                    createOffsetRange(document, absoluteStart, absoluteEnd, docLength),
                    t('validation.unknownSymbol', { symbols: unresolved.length ? unresolved.join(', ') : name })
                )
            );
        }

        return diagnostics;
    }

    function collectStrayTokenLiveDiagnosticsForLine(document, lineNumber, ctx, lineText, strippedLineText, allStrippedLines, lineStartOffset, docLength) {
        const diagnostics = [];
        const trimmedLine = String(strippedLineText || lineText || '').trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) return diagnostics;
        const escapeChar = ctx?.resolver?.ctrlCharAtLine?.(lineNumber) || '';
        const looksLikeExpressionFragment = source => {
            const trimmed = String(source || '').trim();
            return !!looksLikePawnExpressionFragment(trimmed, {
                escapeChar,
                allowLeadingBinaryOperator: true
            });
        };
        const findNearbyNonEmptyLine = (startLine, step) => {
            for (let probe = startLine + step; probe >= 0 && probe < allStrippedLines.length; probe += step) {
                const candidate = String(allStrippedLines[probe] || '').trim();
                if (candidate) return candidate;
            }
            return '';
        };

        if (isFunctionHeaderLine(ctx, lineNumber)) return diagnostics;
        if (parseLabelDeclaration(strippedLineText || lineText)) {
            return diagnostics;
        }

        if (/^["']/.test(trimmedLine)) {
            const previousLine = findNearbyNonEmptyLine(lineNumber, -1);
            const nextLine = findNearbyNonEmptyLine(lineNumber, 1);
            const looksLikeCollectionContext =
                previousLine.endsWith('{') ||
                previousLine.endsWith(',') ||
                nextLine.startsWith('}') ||
                nextLine.endsWith(',');
            if (looksLikeCollectionContext) {
                return diagnostics;
            }
        }

        if (/^[{}]+;?$/.test(trimmedLine)) return diagnostics;
        if (/^(?:new|static|stock|public|private|const|native|forward|enum)\b/.test(trimmedLine)) return diagnostics;
        if (/^(?:if|for|while|switch|return|case|default|else|do)\b/.test(trimmedLine)) return diagnostics;
        if (/[=([{,:?]/.test(trimmedLine)) return diagnostics;
        if (trimmedLine.endsWith(';')) return diagnostics;
        if (looksLikeExpressionFragment(trimmedLine)) return diagnostics;
        const previousLine = findNearbyNonEmptyLine(lineNumber, -1);
        if (previousLine.endsWith(',')) {
            const trailingCloserTrimmed = trimmedLine.replace(/[)\]}]+[,;]?\s*$/, '').trimEnd();
            if (trailingCloserTrimmed && looksLikeExpressionFragment(trailingCloserTrimmed)) {
                return diagnostics;
            }
        }

        const singleTokenMatch = trimmedLine.match(/^(\S+)$/);
        if (!singleTokenMatch) return diagnostics;
        const token = singleTokenMatch[1];
        if (token === '_') return diagnostics;
        const delimiterPrefixedIdentifierTailMatch = token.match(/^([)\]}]+)((?:[A-Za-z_@][A-Za-z0-9_@]*)|(?:[^\x00-\x7F]+))$/);
        if (delimiterPrefixedIdentifierTailMatch) {
            const tokenStart = lineText.indexOf(token);
            const suffix = delimiterPrefixedIdentifierTailMatch[2];
            const suffixStart = tokenStart >= 0 ? tokenStart + delimiterPrefixedIdentifierTailMatch[1].length : -1;
            const suffixKnown = ignoredUnknownSymbolNames.has(suffix) ||
                !!ctx.lookup?.findAnyDeclByName?.(suffix);
            if (suffixStart >= 0 && !suffixKnown) {
                diagnostics.push(
                    createLiveValidationDiagnostic(
                        createOffsetRange(
                            document,
                            lineStartOffset + suffixStart,
                            lineStartOffset + suffixStart + suffix.length,
                            docLength
                        ),
                        t('validation.unknownSymbol', { symbols: suffix })
                    )
                );
            }
            return diagnostics;
        }
        if (/^[A-Za-z_@][A-Za-z0-9_@]*$/.test(token)) return diagnostics;
        if (/^(?:\+\+|--)[A-Za-z_@][A-Za-z0-9_@]*$/.test(token)) return diagnostics;
        if (/^[A-Za-z_@][A-Za-z0-9_@]*(?:\+\+|--)$/.test(token)) return diagnostics;
        if (nonAsciiCharRe.test(token)) {
            return diagnostics;
        }

        const startIndex = lineText.indexOf(token);
        if (startIndex < 0) return diagnostics;
        diagnostics.push(
            createLiveValidationDiagnostic(
                createOffsetRange(
                    document,
                    lineStartOffset + startIndex,
                    lineStartOffset + startIndex + token.length,
                    docLength
                ),
                t('validation.unexpectedToken', { token })
            )
        );
        return diagnostics;
    }

    return {
        collectUnknownSymbolLiveDiagnosticsForLine,
        collectStrayTokenLiveDiagnosticsForLine
    };
}

module.exports = { createSymbolDiagnostics };
