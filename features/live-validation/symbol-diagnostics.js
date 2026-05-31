const {
    PAWN_IDENTIFIER_NAME_RE,
    PAWN_IDENTIFIER_SOURCE,
    containsPawnIdentifierStartChar,
    getPawnIdentifierName,
    isPawnIdentifierContinueCode,
    isPawnIdentifierStartCode
} = require('../../core/syntax/identifiers');
const {
    startsWithControlKeyword,
    startsWithDeclarationKeyword
} = require('../../core/syntax/keywords');
const { isPreprocessorDirectiveLine } = require('../../core/syntax/preprocessor-lines');
const { isCompilerMultilineOperatorBridgeLine } = require('../../core/syntax/control-lines');
const { getTypeAnalysisSourceDecls } = require('../../core/validation/type-analysis-cache');

const DELIMITER_PREFIXED_IDENTIFIER_TAIL_RE = new RegExp(`^([)\\]}]+)((?:${PAWN_IDENTIFIER_SOURCE})|(?:[^\\x00-\\x7F]+))$`);
const PREFIXED_INCREMENT_IDENTIFIER_RE = new RegExp(`^(?:\\+\\+|--)${PAWN_IDENTIFIER_SOURCE}$`);
const SUFFIXED_INCREMENT_IDENTIFIER_RE = new RegExp(`^${PAWN_IDENTIFIER_SOURCE}(?:\\+\\+|--)$`);
const EMPTY_DIAGNOSTICS = Object.freeze([]);

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
        isHexLiteralIdentifierTail,
        isIdentifierContinueChar,
        isIdentifierStartChar,
        isIncludeDocument,
        isStrictIncludeValidationEnabled,
        looksLikePawnExpressionFragment,
        nonAsciiCharRe,
        parseLabelDeclaration,
        parseStateStatement,
        t
    } = deps;
    const canUseFastPawnIdentifierCodes = !!(
        isIdentifierStartChar('A') &&
        isIdentifierStartChar('_') &&
        isIdentifierStartChar('@') &&
        !isIdentifierStartChar('0') &&
        isIdentifierContinueChar('A') &&
        isIdentifierContinueChar('_') &&
        isIdentifierContinueChar('@') &&
        isIdentifierContinueChar('0') &&
        !isIdentifierContinueChar('-')
    );
    function collectUnknownSymbolLiveDiagnosticsForLine(document, lineNumber, ctx, analysisCacheOrFactory, lineText, strippedLineText, lineStartOffset, docLength, declarationSourceState = null, lookupState = null) {
        let diagnostics = null;
        const includeDocument = isIncludeDocument(document);
        if (includeDocument && !isStrictIncludeValidationEnabled()) return EMPTY_DIAGNOSTICS;
        const getAnalysisCache = () => (
            typeof analysisCacheOrFactory === 'function'
                ? analysisCacheOrFactory()
                : analysisCacheOrFactory
        );
        const pushDiagnostic = diagnostic => {
            if (!diagnostic) return;
            if (!diagnostics) diagnostics = [];
            diagnostics.push(diagnostic);
        };
        const finishDiagnostics = () => diagnostics || EMPTY_DIAGNOSTICS;

        const rawLineText = String(lineText || '');
        const strippedScanText = String(strippedLineText || rawLineText);
        const trimmedLine = strippedScanText.trim();
        if (!trimmedLine || isPreprocessorDirectiveLine(trimmedLine)) return EMPTY_DIAGNOSTICS;
        if (!containsPawnIdentifierStartChar(strippedScanText) && !nonAsciiCharRe.test(strippedScanText)) return EMPTY_DIAGNOSTICS;
        const multilineStringLineFlags = getMultilineStringLineFlags(ctx);
        if (multilineStringLineFlags[lineNumber]) return EMPTY_DIAGNOSTICS;

        if (isFunctionHeaderLine(ctx, lineNumber)) return EMPTY_DIAGNOSTICS;
        if (isEnumMemberDeclarationLine(ctx, lineNumber)) return EMPTY_DIAGNOSTICS;

        let lookupNameCache = null;
        if (lookupState?.byLookup instanceof WeakMap && ctx.lookup) {
            lookupNameCache = lookupState.byLookup.get(ctx.lookup);
            if (!lookupNameCache) {
                lookupNameCache = new Map();
                lookupState.byLookup.set(ctx.lookup, lookupNameCache);
            }
        }
        const findAnyDeclByName = name => {
            if (lookupNameCache) {
                if (lookupNameCache.has(name)) return lookupNameCache.get(name);
                const decl = ctx.lookup.findAnyDeclByName(name) || null;
                lookupNameCache.set(name, decl);
                return decl;
            }
            return ctx.lookup.findAnyDeclByName(name) || null;
        };
        let seen = null;
        const hasSeen = key => !!(seen && seen.has(key));
        const markSeen = key => {
            if (!seen) seen = new Set();
            seen.add(key);
        };
        const escapeChar = ctx.resolver.ctrlCharAtLine(lineNumber);
        const canTrustStrippedScan = strippedScanText.length === rawLineText.length;
        const identifierScanText = canTrustStrippedScan ? strippedScanText : rawLineText;
        const mayContainGotoKeyword = identifierScanText.includes('goto');
        const bareIdentifierName = getPawnIdentifierName(trimmedLine);
        const stateStatement = parseStateStatement(strippedLineText || lineText);
        const warningsEnabled = areWarningDiagnosticsEnabled();
        const isStateStatementSyntaxName = (start, end) => !!(
            stateStatement &&
            (
                (start >= stateStatement.keywordStart && end <= stateStatement.keywordEnd) ||
                (stateStatement.automatonStart >= 0 && start >= stateStatement.automatonStart && end <= stateStatement.automatonEnd) ||
                (stateStatement.stateStart >= 0 && start >= stateStatement.stateStart && end <= stateStatement.stateEnd)
            )
        );
        const pushSymbolTruncationWarning = (name, start, end) => {
            if (!warningsEnabled) return false;
            const issue = getSymbolTruncationIssue(name);
            if (!issue) return false;
            const key = `truncated:${start}:${end}:${name}`;
            if (hasSeen(key)) return true;
            markSeen(key);
            pushDiagnostic(
                createLiveValidationDiagnostic(
                    createOffsetRange(document, lineStartOffset + start, lineStartOffset + end, docLength),
                    t(issue.messageKey, issue.params || {}),
                    getWarningSeverity()
                )
            );
            return true;
        };

        if (bareIdentifierName && !ignoredUnknownSymbolNames.has(bareIdentifierName)) {
            const startIndex = lineText.indexOf(bareIdentifierName);
            if (startIndex >= 0) {
                pushSymbolTruncationWarning(
                    bareIdentifierName,
                    startIndex,
                    startIndex + bareIdentifierName.length
                );
            }
            if (!findAnyDeclByName(bareIdentifierName)) {
                const analysisCache = getAnalysisCache();
                const unresolved = findUnresolvedReferenceNames(
                    bareIdentifierName,
                    getTypeAnalysisSourceDecls(ctx, analysisCache),
                    analysisCache,
                    escapeChar
                );
                if (!unresolved.length) {
                    return finishDiagnostics();
                }
                if (startIndex >= 0) {
                    pushDiagnostic(
                        createLiveValidationDiagnostic(
                            createOffsetRange(
                                document,
                                lineStartOffset + startIndex,
                                lineStartOffset + startIndex + bareIdentifierName.length,
                                docLength
                            ),
                            t('validation.unknownSymbol', { symbols: unresolved.length ? unresolved.join(', ') : bareIdentifierName })
                        )
                    );
                    return finishDiagnostics();
                }
            }
            return finishDiagnostics();
        }

        const findPreviousWordBefore = index => {
            let cursor = findPreviousNonWhitespaceIndex(identifierScanText, index - 1);
            if (cursor < 0) return '';
            let end = cursor + 1;
            while (cursor >= 0 && isIdentifierContinueAt(cursor)) {
                cursor--;
            }
            const start = cursor + 1;
            if (start >= end) return '';
            return identifierScanText.slice(start, end);
        };
        const isIdentifierStartAt = canUseFastPawnIdentifierCodes
            ? index => isPawnIdentifierStartCode(identifierScanText.charCodeAt(index))
            : index => isIdentifierStartChar(identifierScanText[index] || '');
        const isIdentifierContinueAt = canUseFastPawnIdentifierCodes
            ? index => isPawnIdentifierContinueCode(identifierScanText.charCodeAt(index))
            : index => isIdentifierContinueChar(identifierScanText[index] || '');

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
            if (!isIdentifierStartAt(index)) continue;
            if (index > 0 && isIdentifierContinueAt(index - 1)) continue;
            if (isHexLiteralIdentifierTail(identifierScanText, index)) continue;

            const start = index;
            let end = index + 1;
            while (end < identifierScanText.length && isIdentifierContinueAt(end)) end++;
            const name = identifierScanText.slice(start, end);
            index = end - 1;

            if (ignoredUnknownSymbolNames.has(name)) continue;
            if (isStateStatementSyntaxName(start, end)) continue;
            pushSymbolTruncationWarning(name, start, end);

            const prevIndex = findPreviousNonWhitespaceIndex(identifierScanText, start - 1);
            const nextIndex = findFirstNonWhitespaceIndex(identifierScanText, end);
            const prevChar = prevIndex >= 0 ? identifierScanText[prevIndex] : '';
            const nextChar = nextIndex >= 0 ? identifierScanText[nextIndex] : '';
            if (nextChar === ':') continue;
            if (prevChar === '.' && nextChar === '=') continue;
            if (mayContainGotoKeyword && findPreviousWordBefore(start) === 'goto') continue;

            if (nextChar === '(') {
                if (findAnyDeclByName(name)) continue;
                if (includeDocument) continue;
                // Function-call unknowns are emitted by collectCallLiveDiagnostics().
                continue;
            }

            const knownDecl = findAnyDeclByName(name);
            if (knownDecl) continue;
            const absoluteStart = lineStartOffset + start;
            const absoluteEnd = lineStartOffset + end;
            const declarationVariableDecl = findDocumentVariableDeclByName(ctx, name, lineNumber, { sameLineOnly: true });
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
                getTypeAnalysisSourceDecls(ctx, analysisCache),
                analysisCache,
                escapeChar
            );
            if (!unresolved.length) continue;

            const key = `${start}:${end}:${name}`;
            if (hasSeen(key)) continue;
            markSeen(key);
            pushDiagnostic(
                createLiveValidationDiagnostic(
                    createOffsetRange(document, absoluteStart, absoluteEnd, docLength),
                    t('validation.unknownSymbol', { symbols: unresolved.length ? unresolved.join(', ') : name })
                )
            );
        }

        return finishDiagnostics();
    }

    function collectStrayTokenLiveDiagnosticsForLine(document, lineNumber, ctx, lineText, strippedLineText, allStrippedLines, lineStartOffset, docLength) {
        const diagnostics = [];
        const trimmedLine = String(strippedLineText || lineText || '').trim();
        if (!trimmedLine || isPreprocessorDirectiveLine(trimmedLine)) return diagnostics;
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
        if (startsWithDeclarationKeyword(trimmedLine)) return diagnostics;
        if (startsWithControlKeyword(trimmedLine)) return diagnostics;
        if (/[=([{,:?]/.test(trimmedLine)) return diagnostics;
        if (trimmedLine.endsWith(';')) return diagnostics;
        if (looksLikeExpressionFragment(trimmedLine)) return diagnostics;
        if (isCompilerMultilineOperatorBridgeLine(allStrippedLines, lineNumber)) return diagnostics;
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
        const delimiterPrefixedIdentifierTailMatch = token.match(DELIMITER_PREFIXED_IDENTIFIER_TAIL_RE);
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
        if (PAWN_IDENTIFIER_NAME_RE.test(token)) return diagnostics;
        if (PREFIXED_INCREMENT_IDENTIFIER_RE.test(token)) return diagnostics;
        if (SUFFIXED_INCREMENT_IDENTIFIER_RE.test(token)) return diagnostics;
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
