// Shared indexed-access parsing/validation helpers used by hover and live
// validation. This keeps array-dimension logic in one place instead of
// duplicating behavior across UI and diagnostics paths.
const {
    getPawnIdentifierName,
    isPawnIdentifierContinueChar,
    isPawnIdentifierContinueCode,
    isPawnIdentifierName,
    isPawnIdentifierStartChar,
    isPawnIdentifierStartCode
} = require('../syntax/identifiers');
const { splitPawnLines } = require('../syntax/lines');
const { isPawnWhitespaceCode, skipPawnWhitespace } = require('../syntax/whitespace');

function createIndexedAccessCore(deps) {
    const {
        t,
        getActiveCtrlChar,
        getLookupTokenAtPosition,
        getCtrlCharStateForContent,
        isEscapedQuote,
        collectDeclarationText,
        extractEnumSymbolName,
        inferArgType,
        parseTopLevelTernaryExpression,
        parseDimSpec,
        normalizeEnumName,
        getEnumItemCellSpan,
        findUnresolvedReferenceNames,
        evaluatePawnNumericExpr
    } = deps;

    function collectIndexedAccessExpressionsFromLine(lineText, escapeChar = getActiveCtrlChar()) {
        const source = String(lineText || '');
        const results = [];

        let index = 0;
        while (index < source.length) {
            const startCode = source.charCodeAt(index);
            const prevCode = index > 0 ? source.charCodeAt(index - 1) : 0;
            if (!isPawnIdentifierStartCode(startCode) || isPawnIdentifierContinueCode(prevCode)) {
                index++;
                continue;
            }

            let nameEnd = index + 1;
            while (nameEnd < source.length && isPawnIdentifierContinueCode(source.charCodeAt(nameEnd))) nameEnd++;
            const baseName = source.slice(index, nameEnd);

            let cursor = nameEnd;
            const accesses = [];
            while (cursor < source.length) {
                while (cursor < source.length && isPawnWhitespaceCode(source.charCodeAt(cursor))) cursor++;
                if (source.charCodeAt(cursor) !== 91) break;

                const accessStart = cursor;
                let depth = 0;
                let inStr = false;
                let strChCode = 0;

                for (; cursor < source.length; cursor++) {
                    const code = source.charCodeAt(cursor);
                    if (inStr) {
                        if (code === strChCode && !isEscapedQuote(source, cursor, escapeChar)) inStr = false;
                        continue;
                    }
                    if (code === 34 || code === 39) {
                        inStr = true;
                        strChCode = code;
                        continue;
                    }
                    if (code === 91) depth++;
                    else if (code === 93) {
                        depth--;
                        if (depth === 0) {
                            accesses.push({
                                text: source.slice(accessStart, cursor + 1),
                                start: accessStart,
                                end: cursor + 1
                            });
                            cursor++;
                            break;
                        }
                    }
                }

                if (depth !== 0) break;
            }

            if (accesses.length) {
                const exprEnd = accesses[accesses.length - 1]?.end ?? cursor;
                results.push({
                    baseName,
                    start: index,
                    end: exprEnd,
                    baseStart: index,
                    baseEnd: nameEnd,
                    suffix: source.slice(nameEnd, cursor),
                    accesses
                });
                index = cursor;
                continue;
            }

            index = nameEnd;
        }

        return results;
    }

    function isDeclarationDimensionIndexedExpr(lineText, expr) {
        const source = String(lineText || '');
        const prefix = source.slice(0, Math.max(0, expr?.baseStart || 0)).trimEnd();
        if (!prefix) return false;

        const boundary = Math.max(
            prefix.lastIndexOf(';'),
            prefix.lastIndexOf('{'),
            prefix.lastIndexOf('(')
        );
        const segment = prefix.slice(boundary + 1);
        const modifiers = new Set(['new', 'static', 'stock', 'public', 'private', 'const']);
        let cursor = 0;
        let sawModifier = false;

        const readIdentifier = () => {
            const start = cursor;
            if (!isPawnIdentifierStartChar(segment[cursor] || '')) return '';
            cursor++;
            while (cursor < segment.length && isPawnIdentifierContinueChar(segment[cursor])) cursor++;
            return segment.slice(start, cursor);
        };
        const readBraceTag = () => {
            if (segment[cursor] !== '{') return false;
            let depth = 0;
            for (; cursor < segment.length; cursor++) {
                const char = segment[cursor];
                if (char === '{') depth++;
                else if (char === '}') {
                    depth--;
                    if (depth === 0) {
                        cursor++;
                        return true;
                    }
                }
            }
            return false;
        };

        cursor = skipPawnWhitespace(segment, cursor);
        while (cursor < segment.length) {
            const before = cursor;
            const ident = readIdentifier();
            if (ident) {
                if (modifiers.has(ident.toLowerCase())) {
                    sawModifier = true;
                    cursor = skipPawnWhitespace(segment, cursor);
                    continue;
                }
            } else if (!readBraceTag()) {
                return false;
            }

            cursor = skipPawnWhitespace(segment, cursor);
            if (segment[cursor] !== ':') return false;
            cursor++;
            cursor = skipPawnWhitespace(segment, cursor);
            if (cursor === before) return false;
        }

        return sawModifier;
    }

    function findIndexedAccessContextAtPosition(document, position, ctrlCharResolver = null, options = {}) {
        const lineText = document.lineAt(position.line).text;
        const escapeChar = ctrlCharResolver?.ctrlCharAtLine(position.line) || getActiveCtrlChar();
        const expressions = Array.isArray(options.indexedExpressions)
            ? options.indexedExpressions
            : collectIndexedAccessExpressionsFromLine(lineText, escapeChar);
        const character = position.character;

        for (const expr of expressions) {
            if (character < expr.baseStart || character >= expr.end) continue;
            if (isDeclarationDimensionIndexedExpr(lineText, expr)) continue;

            const activeAccessIndex = expr.accesses.findIndex(access =>
                character >= access.start && character < access.end
            );
            return {
                ...expr,
                activeAccessIndex: activeAccessIndex >= 0 ? activeAccessIndex : null
            };
        }

        return null;
    }

    function findIndexedAccessExpressionAtCharacter(expressions, character) {
        if (!Array.isArray(expressions)) return null;
        return expressions.find(expr =>
            character >= expr.baseStart &&
            character < expr.end
        ) || null;
    }

    function getIndexedAccessActiveIndex(expr, character) {
        if (!expr?.accesses?.length) return null;
        const activeAccessIndex = expr.accesses.findIndex(access =>
            character >= access.start &&
            character < access.end
        );
        return activeAccessIndex >= 0 ? activeAccessIndex : null;
    }

    function collectNestedIndexedAccessChain(exprText, relativeCharacter, escapeChar = getActiveCtrlChar()) {
        const chain = [];
        let currentText = String(exprText || '');
        let currentRelativeCharacter = relativeCharacter;
        let offsetBase = 0;

        while (
            currentText &&
            currentRelativeCharacter >= 0 &&
            currentRelativeCharacter < currentText.length
        ) {
            const nestedExpr = findIndexedAccessExpressionAtCharacter(
                collectIndexedAccessExpressionsFromLine(currentText, escapeChar),
                currentRelativeCharacter
            );
            if (!nestedExpr) break;

            const nestedActiveAccessIndex = getIndexedAccessActiveIndex(
                nestedExpr,
                currentRelativeCharacter
            );
            const nestedCtx = {
                ...nestedExpr,
                activeAccessIndex: nestedActiveAccessIndex
            };
            chain.push({
                ctx: nestedCtx,
                offsetBase
            });

            const nestedActiveAccess = nestedActiveAccessIndex != null
                ? nestedCtx.accesses?.[nestedActiveAccessIndex]
                : null;
            if (!nestedActiveAccess) break;

            currentRelativeCharacter -= nestedActiveAccess.start + 1;
            offsetBase += nestedActiveAccess.start + 1;
            currentText = nestedActiveAccess.text.slice(1, -1);
        }

        return chain;
    }

    function getAccessInnerExpression(access) {
        return access?.text ? access.text.slice(1, -1).trim() : '';
    }

    function getIndexedExpressionBaseName(expr) {
        return String(expr || '').trim().match(/^([A-Za-z_@]\w*)\s*\[/)?.[1] || '';
    }

    function resolveDefaultAccessSymbolName(expr, options = {}) {
        const forbiddenTags = options?.forbiddenTags || null;
        let s = String(expr || '').trim();
        if (!s) return '';
        const namedArg = s.match(/^\.\s*([A-Za-z_@]\w*)\s*=\s*(.*)$/);
        if (namedArg) s = namedArg[2].trim();
        if (s.startsWith('&')) s = s.slice(1).trimStart();
        const tagCast = s.match(/^([A-Za-z_@]\w*)\s*:\s*(.+)$/);
        if (tagCast && !(forbiddenTags instanceof Set && forbiddenTags.has(tagCast[1]))) {
            s = tagCast[2].trimStart();
        }
        const indexedBase = getIndexedExpressionBaseName(s);
        if (indexedBase) return indexedBase;
        const quotedId = s.match(/^"([A-Za-z_@]\w*)"$/);
        if (quotedId) return quotedId[1];
        return getPawnIdentifierName(s);
    }

    function buildIndexedAccessSelectionModel(accessCtx, character, escapeChar = getActiveCtrlChar(), options = {}) {
        if (!accessCtx?.accesses?.length) return null;
        const hoveredWord = String(options.hoveredWord || '');
        const resolveSymbolName = typeof options.resolveSymbolName === 'function'
            ? options.resolveSymbolName
            : resolveDefaultAccessSymbolName;
        const activeAccess = accessCtx.activeAccessIndex != null
            ? accessCtx.accesses?.[accessCtx.activeAccessIndex]
            : null;
        const activeAccessRawExpr = activeAccess?.text
            ? activeAccess.text.slice(1, -1)
            : '';
        const activeAccessExpr = activeAccessRawExpr
            ? activeAccessRawExpr.trim()
            : '';
        const activeAccessRelativeCharacter = activeAccess
            ? character - (activeAccess.start + 1)
            : -1;
        const isInsideActiveAccessInterior =
            !!activeAccess &&
            character > activeAccess.start &&
            character < activeAccess.end - 1;
        const nestedChain = activeAccessRawExpr.includes('[') && activeAccess
            ? collectNestedIndexedAccessChain(
                activeAccessRawExpr,
                activeAccessRelativeCharacter,
                escapeChar
            )
            : [];
        const nestedLeafEntry = nestedChain.length ? nestedChain[nestedChain.length - 1] : null;
        const nestedCtx = nestedLeafEntry?.ctx || null;
        const nestedAccessLineOffset = activeAccess
            ? (activeAccess.start + 1) + (nestedLeafEntry?.offsetBase || 0)
            : 0;
        const isOuterAccessClosingBracket =
            !!activeAccess && character === activeAccess.end - 1;
        const nestedPrimaryCtx =
            nestedCtx ||
            (isOuterAccessClosingBracket && nestedChain.length
                ? {
                    ...nestedChain[nestedChain.length - 1].ctx,
                    activeAccessIndex: Math.max(0, nestedChain[nestedChain.length - 1].ctx.accesses.length - 1)
                }
                : null);
        const nestedPrimaryActiveAccess = nestedPrimaryCtx?.activeAccessIndex != null
            ? nestedPrimaryCtx.accesses?.[nestedPrimaryCtx.activeAccessIndex] || null
            : null;
        const nestedPrimaryActiveAccessExpr = getAccessInnerExpression(nestedPrimaryActiveAccess);
        const nestedPrimaryActiveAccessSymbolName =
            getIndexedExpressionBaseName(nestedPrimaryActiveAccessExpr) ||
            resolveSymbolName(nestedPrimaryActiveAccessExpr) ||
            '';
        const nestedPrimaryRelativeCharacter = nestedPrimaryCtx && nestedLeafEntry
            ? activeAccessRelativeCharacter - nestedLeafEntry.offsetBase
            : activeAccessRelativeCharacter;
        const isNestedPrimaryBaseHover =
            !!nestedPrimaryCtx &&
            nestedPrimaryRelativeCharacter >= nestedPrimaryCtx.baseStart &&
            nestedPrimaryRelativeCharacter < nestedPrimaryCtx.baseEnd;
        const previousAccessIndex = accessCtx.activeAccessIndex != null
            ? accessCtx.activeAccessIndex - 1
            : -1;
        const previousAccess = previousAccessIndex >= 0
            ? accessCtx.accesses?.[previousAccessIndex] || null
            : null;
        const previousAccessExpr = getAccessInnerExpression(previousAccess);
        const previousAccessSymbolName =
            getIndexedExpressionBaseName(previousAccessExpr) ||
            resolveSymbolName(previousAccessExpr) ||
            '';
        const activeAccessIndexedBaseName = getIndexedExpressionBaseName(activeAccessExpr);
        const activeAccessSymbolName =
            nestedCtx?.baseName ||
            activeAccessIndexedBaseName ||
            resolveSymbolName(activeAccessExpr) ||
            (hoveredWord && hoveredWord !== accessCtx.baseName ? hoveredWord : '');

        return {
            rootCtx: accessCtx,
            activeAccess,
            activeAccessRawExpr,
            activeAccessExpr,
            activeAccessIndexedBaseName,
            activeAccessSymbolName,
            activeAccessRelativeCharacter,
            isInsideActiveAccessInterior,
            nestedChain,
            nestedLeafEntry,
            nestedCtx,
            nestedAccessLineOffset,
            isOuterAccessClosingBracket,
            nestedPrimaryCtx,
            nestedPrimaryActiveAccess,
            nestedPrimaryActiveAccessExpr,
            nestedPrimaryActiveAccessSymbolName,
            isNestedPrimaryBaseHover,
            previousAccessIndex,
            previousAccess,
            previousAccessExpr,
            previousAccessSymbolName
        };
    }

    function isVariableDeclarationNameAtPosition(document, position, variableDecls, ctrlCharResolver = null, sourceText = '') {
        const token = getLookupTokenAtPosition(document, position, { ctrlCharResolver });
        if (!token?.text) return false;

        const word = token.text;
        const text = String(sourceText || document.getText());
        const lineCtrlChars = ctrlCharResolver?.lineCtrlChars || getCtrlCharStateForContent(text, document.fileName).lineCtrlChars;
        const rawLines = splitPawnLines(text);

        for (const decl of variableDecls) {
            if (decl?.type !== 'variable' || decl.name !== word) continue;
            if (decl.lineNumber > position.line) continue;

            const { nextLine } = collectDeclarationText(rawLines, decl.lineNumber, lineCtrlChars);
            if (position.line < decl.lineNumber || position.line >= nextLine) continue;
            return true;
        }

        return false;
    }

    function explainIndexedAccessDimCompat(expectedDimPart, actualExpr, allDecls, options = {}) {
        const { analysisCache = null } = options;
        const actual = String(actualExpr || '').trim();
        if (!actual) {
            return { status: 'ok', reason: '' };
        }
        const compatCacheKey = `${String(expectedDimPart || '')}|||${actual}`;
        if (analysisCache?.indexedDimCompatByKey.has(compatCacheKey)) {
            return analysisCache.indexedDimCompatByKey.get(compatCacheKey);
        }
        const cacheResult = result => {
            if (analysisCache) {
                analysisCache.indexedDimCompatByKey.set(compatCacheKey, result);
            }
            return result;
        };
        const expectedPart = analysisCache?.getDimSpec(expectedDimPart) ||
            parseDimSpec(expectedDimPart, allDecls, new Set(), analysisCache);
        const ternaryExpr = parseTopLevelTernaryExpression(actual);
        if (ternaryExpr) {
            const whenTrueResult = explainIndexedAccessDimCompat(
                expectedDimPart,
                ternaryExpr.whenTrue,
                allDecls,
                options
            );
            const whenFalseResult = explainIndexedAccessDimCompat(
                expectedDimPart,
                ternaryExpr.whenFalse,
                allDecls,
                options
            );
            if (whenTrueResult.status === 'ok' && whenFalseResult.status === 'ok') {
                return cacheResult({ status: 'ok', reason: '' });
            }
            if (whenTrueResult.status !== 'error' && whenFalseResult.status !== 'error') {
                return cacheResult(
                    whenTrueResult.status === 'warn'
                        ? whenTrueResult
                        : whenFalseResult
                );
            }
            return cacheResult(
                whenTrueResult.status === 'error'
                    ? whenTrueResult
                    : whenFalseResult
            );
        }
        const actualNumericValue = evaluatePawnNumericExpr(actual, allDecls, new Set(), analysisCache);
        const actualBareName = getPawnIdentifierName(actual);
        const findActualEnumItemDecl = () => actualBareName
            ? (
                analysisCache?.findAnyDeclByName(
                    actualBareName,
                    item => item.type === 'enum-item'
                ) ||
                allDecls.find(item => item?.type === 'enum-item' && item.name === actualBareName) ||
                null
            )
            : null;
        const expectedSymbolName = expectedPart.enumName || extractEnumSymbolName(expectedDimPart);
        const expectedEnumDecl = expectedSymbolName
            ? (
                analysisCache?.findDeclByName(
                    expectedSymbolName,
                    item => item.type === 'enum'
                ) || allDecls.find(item => item.type === 'enum' && item.name === expectedSymbolName)
            )
            : null;
        const expectedEnumName = expectedEnumDecl?.name || '';
        const hasResolvedCapacity = expectedPart.capacity != null;
        const createIndexTagMismatch = name => ({
            status: 'warn',
            reason: t('validation.indexTagMismatch', { name: name || expectedEnumName || expectedSymbolName || '' })
        });

        if (actualNumericValue != null) {
            if (!hasResolvedCapacity && expectedSymbolName && !expectedEnumDecl) {
                return cacheResult({
                    status: 'error',
                    reason: t('validation.unknownDimensionSymbol', { symbol: expectedSymbolName })
                });
            }

            if (expectedPart.capacity != null) {
                const enumItemDecl = findActualEnumItemDecl();
                const enumItemSpan = getEnumItemCellSpan(enumItemDecl, allDecls, analysisCache);
                const actualEndValue = enumItemDecl && enumItemSpan != null
                    ? actualNumericValue + Math.max(1, enumItemSpan) - 1
                    : actualNumericValue;
                if (actualNumericValue < 0 || actualEndValue >= expectedPart.capacity) {
                    if (
                        enumItemDecl &&
                        enumItemSpan != null &&
                        enumItemSpan > 1 &&
                        actualNumericValue >= 0 &&
                        actualNumericValue < expectedPart.capacity
                    ) {
                        return cacheResult({
                            status: 'error',
                            reason: t('validation.enumFieldRequiresArrayTarget', {
                                name: enumItemDecl.name || actualBareName,
                                dims: enumItemDecl.dims || ''
                            })
                        });
                    }
                    return cacheResult({
                        status: 'error',
                        reason: enumItemDecl
                            ? t('validation.enumFieldOutOfBounds', {
                                name: enumItemDecl.name || actualBareName,
                                max: expectedPart.capacity - 1,
                                actual: actualEndValue
                            })
                            : t('validation.indexOutOfBounds', { max: expectedPart.capacity - 1, actual: actualNumericValue })
                    });
                }
            }
            return cacheResult({ status: 'ok', reason: '' });
        }

        const bareName = actualBareName;
        if (bareName) {
            if (expectedEnumName) {
                const memberDecl = expectedEnumDecl.enumMembers?.find(item => item.name === bareName) ||
                    analysisCache?.findDeclByName(
                        bareName,
                        item => item.type === 'enum-item' && normalizeEnumName(item.enumName) === normalizeEnumName(expectedEnumName)
                    ) ||
                    allDecls.find(item =>
                        item.type === 'enum-item' &&
                        item.name === bareName &&
                        normalizeEnumName(item.enumName) === normalizeEnumName(expectedEnumName)
                    );
                if (memberDecl) {
                    return cacheResult({ status: 'ok', reason: '' });
                }
            }
            if (!hasResolvedCapacity && expectedSymbolName && !expectedEnumDecl) {
                return cacheResult({
                    status: 'error',
                    reason: t('validation.unknownDimensionSymbol', { symbol: expectedSymbolName })
                });
            }

            const bareDecl = analysisCache?.findAnyDeclByName(bareName) ||
                allDecls.find(item => item?.name === bareName) ||
                null;
            if (!bareDecl) {
                return cacheResult({
                    status: 'error',
                    reason: t('validation.unknownSymbol', { symbols: bareName })
                });
            }

            if (bareDecl.type === 'variable' && bareDecl.dims) {
                return cacheResult({
                    status: 'error',
                    reason: t('validation.indexMustBeScalar')
                });
            }

            const bareTag = String(bareDecl.typeTag || '').toLowerCase();
            if (bareTag === 'float') {
                return cacheResult({
                    status: 'warn',
                    reason: t('validation.indexMustNotBeFloat')
                });
            }

            if (expectedEnumName) {
                if (String(bareDecl.typeTag || '') === expectedEnumName) {
                    return cacheResult({ status: 'ok', reason: '' });
                }
                if (
                    bareDecl.type === 'variable' &&
                    !bareDecl.dims &&
                    !bareTag
                ) {
                    return cacheResult({ status: 'ok', reason: '' });
                }
                return cacheResult(createIndexTagMismatch(bareDecl.typeTag || bareDecl.name || bareName));
            }

            return cacheResult({ status: 'ok', reason: '' });
        }

        const unresolvedRefs = findUnresolvedReferenceNames(actual, allDecls, analysisCache);
        if (unresolvedRefs.length) {
            return cacheResult({
                status: 'error',
                reason: t('validation.unknownSymbol', { symbols: unresolvedRefs.join(', ') })
            });
        }

        const actualType = inferArgType(actual, allDecls, analysisCache);
        if (actualType.dims) {
            return cacheResult({
                status: 'error',
                reason: t('validation.indexMustBeScalar')
            });
        }

        if (actualType.tag && actualType.tag.toLowerCase() === 'float') {
            return cacheResult({
                status: 'warn',
                reason: t('validation.indexMustNotBeFloat')
            });
        }

        if (expectedEnumName) {
            if (!expectedEnumDecl) {
                return cacheResult({
                    status: 'error',
                    reason: t('validation.unknownDimensionSymbol', { symbol: expectedSymbolName })
                });
            }

            const memberName = getPawnIdentifierName(actual);
            const memberDecl = memberName && (
                expectedEnumDecl.enumMembers?.find(item => item.name === memberName) ||
                analysisCache?.findDeclByName(
                    memberName,
                    item => item.type === 'enum-item' && normalizeEnumName(item.enumName) === normalizeEnumName(expectedEnumName)
                ) ||
                allDecls.find(item =>
                    item.type === 'enum-item' &&
                    item.name === memberName &&
                    normalizeEnumName(item.enumName) === normalizeEnumName(expectedEnumName)
                )
            );
            if (memberDecl) {
                return cacheResult({ status: 'ok', reason: '' });
            }
            if (String(actualType.tag || '') === expectedEnumName) {
                return cacheResult({ status: 'ok', reason: '' });
            }

            if (!isPawnIdentifierName(actual)) {
                return cacheResult({ status: 'ok', reason: '' });
            }

            return cacheResult(createIndexTagMismatch(actualType.tag || memberName || actual));
        }

        return cacheResult({ status: 'ok', reason: '' });
    }

    return {
        collectIndexedAccessExpressionsFromLine,
        findIndexedAccessContextAtPosition,
        collectNestedIndexedAccessChain,
        buildIndexedAccessSelectionModel,
        resolveDefaultAccessSymbolName,
        isVariableDeclarationNameAtPosition,
        explainIndexedAccessDimCompat
    };
}

module.exports = { createIndexedAccessCore };
