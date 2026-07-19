const { createUtilityCore } = require('../utils/runtime');
const { normalizePathKey } = require('../utils/path');
const {
    isAnyPawnTagName,
    isFixedPawnTagName,
    normalizePawnTagName
} = require('../syntax/tags');
const {
    containsPawnIdentifierStartChar,
    getPawnIdentifierName,
    isPawnIdentifierContinueCode,
    isPawnIdentifierName,
    isPawnIdentifierStartCode
} = require('../syntax/identifiers');
const {
    getObjectAliasTargetName,
    isObjectAliasDefineDecl
} = require('../declarations/aliases');
const { hasDeclModifier } = require('../declarations/modifiers');
const { findBalancedGroupEnd: findBalancedGroupEndCore } = require('../syntax/balanced');
const { createSemanticSyntaxCore } = require('../syntax/semantic-classifier');
const { createMacroExpansionSyntaxCore } = require('../syntax/macro-expander');
const { getCompilerBuiltinTypeInfo } = require('../syntax/compiler-builtins');
const {
    findPreviousNonWhitespaceIndex: findPreviousPawnNonWhitespaceIndex,
    skipPawnWhitespace
} = require('../syntax/whitespace');
const { createArrayShapeCore } = require('../array-shape');
const { createArrayShapeDiagnosticsCore } = require('./array-shape-diagnostics');
const { getEnumMemberTagNameForExpression } = require('./enum-member-tag-compat');
const { createNumericDimensionValidationCore } = require('./numeric-dimensions');
const { createParamMetaCore } = require('./param-meta');
const { createTypeCompatCore } = require('./type-compat');
const { createTypeAnalysisCacheFactory } = require('./type-analysis-cache');
const {
    evaluatePawnCharacterLiteralValue: evaluatePawnCharacterLiteralValueCore,
    replaceNumericCharacterLiteralsForValidation: replaceNumericCharacterLiteralsForValidationCore
} = require('./literal-utils');

const {
    isPawnIdentifierStartChar: defaultIsPawnIdentifierStartChar,
    isPawnIdentifierContinueChar: defaultIsPawnIdentifierContinueChar
} = createUtilityCore();

// Shared validation/type-inference layer used by hover and live validation.
// The module is dependency-injected on purpose so we can keep behavior stable
// while gradually moving hot paths out of the main extension file.
function createValidationCore(deps) {
    const {
        vscode,
        fs,
        t,
        getActiveCtrlChar,
        isEscapedQuote,
        measurePawnStringLiteral,
        splitTopLevel,
        escapeRegExp,
        unwrapOuterParens,
        extractEnumSymbolName,
        findDeclByNameCached,
        getDeclNameBuckets,
        isFunctionLikeDecl,
        BUILTIN_DECLS,
        FORBIDDEN,
        TAG_RE,
        isPawnIdentifierStartChar = defaultIsPawnIdentifierStartChar,
        isPawnIdentifierContinueChar = defaultIsPawnIdentifierContinueChar
    } = deps;
    const effectiveDeclDimPartsCache = new WeakMap();
    const functionReturnTypeCache = new WeakMap();
    const functionReturnTypeStableCache = new Map();
    const normalizeCachePath = normalizePathKey;
    const semanticSyntaxCore = createSemanticSyntaxCore({
        isEscapedQuote,
        isIdentifierStartChar: isPawnIdentifierStartChar,
        isIdentifierContinueChar: isPawnIdentifierContinueChar
    });
    const usesDefaultPawnIdentifierPredicates =
        isPawnIdentifierStartChar === defaultIsPawnIdentifierStartChar &&
        isPawnIdentifierContinueChar === defaultIsPawnIdentifierContinueChar;
    const macroExpansionCore = createMacroExpansionSyntaxCore({
        isEscapedQuote,
        isIdentifierStartChar: isPawnIdentifierStartChar,
        isIdentifierContinueChar: isPawnIdentifierContinueChar,
        splitTopLevel
    });
    const parseBraceArrayLiteralExpression = (expr, escapeChar = getActiveCtrlChar()) =>
        semanticSyntaxCore.parseBraceArrayLiteralExpression(expr, { escapeChar });
    const {
        parseParamMeta,
        parseUnionTagOptions
    } = createParamMetaCore({
        getActiveCtrlChar,
        isEscapedQuote,
        TAG_RE
    });
    const parseIndexedAccessExpression = (expr, escapeChar = getActiveCtrlChar(), options = {}) => {
        const expressionOptions = typeof escapeChar === 'object' && escapeChar !== null
            ? { ...escapeChar }
            : { ...(options || {}), escapeChar };
        if (expressionOptions.escapeChar == null) {
            expressionOptions.escapeChar = getActiveCtrlChar();
        }
        return semanticSyntaxCore.parseIndexedAccessExpression(expr, expressionOptions);
    };
    const isVariableDecl = item => item?.type === 'variable';
    const getOpenDocumentForFile = filePath => {
        const targetPath = normalizeCachePath(filePath);
        if (!targetPath) return null;
        for (const doc of vscode?.workspace?.textDocuments || []) {
            if (normalizeCachePath(doc?.fileName) === targetPath) {
                return doc;
            }
        }
        return null;
    };
    const getTextLineStartOffset = (source, targetLine) => {
        const text = String(source || '');
        const line = Math.max(0, Number.isInteger(targetLine) ? targetLine : 0);
        let offset = 0;
        for (let currentLine = 0; currentLine < line; currentLine++) {
            const newlineIndex = text.indexOf('\n', offset);
            if (newlineIndex < 0) return text.length;
            offset = newlineIndex + 1;
        }
        return offset;
    };
    const isBoolTagName = value => normalizePawnTagName(value).toLowerCase() === 'bool';
    const isImplicitBoolToScalarCompat = (expectedTag, actualTag, actualDims) => {
        if (String(actualDims || '').trim()) return false;
        const expected = normalizePawnTagName(expectedTag);
        const actual = normalizePawnTagName(actualTag);
        return (
            (!expected || expected === '_') && isBoolTagName(actual)
        ) || (
            isBoolTagName(expected) && (!actual || actual === '_')
        );
    };
    const normalizeEnumName = normalizePawnTagName;
    const normalizeTagName = normalizePawnTagName;
    const isAnyTagName = isAnyPawnTagName;

    function isIdentifierStartChar(char = '') {
        return isPawnIdentifierStartChar(char);
    }

    function isIdentifierContinueChar(char = '') {
        return isPawnIdentifierContinueChar(char);
    }

    const evaluatePawnCharacterLiteralValue = (literal, escapeChar = getActiveCtrlChar()) =>
        evaluatePawnCharacterLiteralValueCore(literal, escapeChar);
    const replaceNumericCharacterLiteralsForValidation = (source, escapeChar = getActiveCtrlChar()) =>
        replaceNumericCharacterLiteralsForValidationCore(source, escapeChar);

    const {
        evaluatePawnNumericExpr,
        isResolvedDimSpec,
        parseDimSpec,
        parseDimsParts
    } = createNumericDimensionValidationCore({
        evaluatePawnCharacterLiteralValue,
        extractEnumSymbolName,
        findAnyDeclByNameFromSources,
        FORBIDDEN,
        getActiveCtrlChar,
        getEffectiveDeclDimParts,
        getEnumDeclResolvedCapacity,
        macroExpansionCore,
        replaceNumericCharacterLiteralsForValidation,
        semanticSyntaxCore
    });

    function isHexLiteralIdentifierTail(source, startIndex) {
        const text = String(source || '');
        if (startIndex <= 0) return false;
        if (text[startIndex] === 'x' || text[startIndex] === 'X') {
            if (text[startIndex - 1] !== '0') return false;
            return /[0-9a-fA-F]/.test(text[startIndex + 1] || '');
        }
        if (!/[a-fA-F]/.test(text[startIndex] || '')) return false;

        let probe = startIndex - 1;
        while (probe >= 0 && /[0-9a-fA-F]/.test(text[probe])) probe--;
        return probe >= 1 &&
            (text[probe] === 'x' || text[probe] === 'X') &&
            text[probe - 1] === '0';
    }

    function findDeclByNameFromList(decls = [], name = '', predicate = null) {
        if (!name) return null;
        if (predicate || (Array.isArray(decls) && decls.length >= 24)) {
            return findDeclByNameCached(decls, name, predicate);
        }
        return decls.find(item => item.name === name && (!predicate || predicate(item))) || null;
    }

    function findAnyDeclByNameFromSources(decls = [], name = '', predicate = null, analysisCache = null) {
        if (!name) return null;
        if (analysisCache?.findAnyDeclByName) {
            return analysisCache.findAnyDeclByName(name, predicate);
        }
        return findDeclByNameFromList(decls, name, predicate) ||
            findDeclByNameCached(BUILTIN_DECLS, name, predicate);
    }

    function findLocalDeclByNameFromSources(decls = [], name = '', predicate = null, analysisCache = null) {
        if (!name) return null;
        if (analysisCache?.findDeclByName) {
            return analysisCache.findDeclByName(name, predicate);
        }
        return findDeclByNameFromList(decls, name, predicate);
    }

    function findObjectAliasTargetDeclByNameFromSources(decls = [], name = '', predicate = null, analysisCache = null, seen = null) {
        const aliasName = String(name || '').trim();
        if (!aliasName || seen?.has(aliasName)) return null;
        const aliasDefine = findAnyDeclByNameFromSources(
            decls,
            aliasName,
            isObjectAliasDefineDecl,
            analysisCache
        );
        const targetName = getObjectAliasTargetName(aliasDefine);
        if (!targetName || seen?.has(targetName)) return null;
        const directTarget = findAnyDeclByNameFromSources(decls, targetName, predicate, analysisCache);
        if (directTarget) return directTarget;
        const localSeen = seen || new Set();
        localSeen.add(aliasName);
        const resolved = findObjectAliasTargetDeclByNameFromSources(decls, targetName, predicate, analysisCache, localSeen);
        localSeen.delete(aliasName);
        return resolved;
    }

    function findVariableOrObjectAliasTargetDeclByNameFromSources(decls = [], name = '', analysisCache = null) {
        return findVariableDeclByNameFromSources(decls, name, analysisCache) ||
            findObjectAliasTargetDeclByNameFromSources(
                decls,
                name,
                isVariableDecl,
                analysisCache
            );
    }

    function findFunctionLikeOrObjectAliasTargetDeclByNameFromSources(decls = [], name = '', analysisCache = null) {
        return findAnyDeclByNameFromSources(decls, name, item => isFunctionLikeDecl(item), analysisCache) ||
            findObjectAliasTargetDeclByNameFromSources(
                decls,
                name,
                item => isFunctionLikeDecl(item),
                analysisCache
            );
    }

    const arrayShapeCore = createArrayShapeCore({
        measurePawnStringLiteral,
        parseBraceArrayLiteralExpression,
        parseDimsParts,
        parseDimSpec
    });
    const {
        explainArrayShapeDiagnosticIssue,
        explainArrayShapeIssue,
        getArrayShapeIssue
    } = createArrayShapeDiagnosticsCore({
        findAnyDeclByNameFromSources,
        getActiveCtrlChar,
        isResolvedDimSpec,
        measurePawnStringLiteral,
        normalizeEnumName,
        parseDimSpec,
        parseDimsParts,
        semanticSyntaxCore,
        t,
        unwrapOuterParens
    });
    const createHoverTypeAnalysisCache = createTypeAnalysisCacheFactory({
        BUILTIN_DECLS,
        findDeclByNameCached,
        getDeclNameBuckets,
        parseDimSpec,
        parseDimsParts,
        parseParamMeta
    });

    const arrayScalarIgnoredNames = new Set([
        '_',
        'new', 'static', 'stock', 'public', 'private', 'const', 'native', 'forward',
        'return', 'if', 'for', 'while', 'switch', 'case', 'default', 'do', 'else',
        'sizeof', 'tagof', 'defined', 'state', 'goto', 'assert', 'sleep', 'exit', 'enum',
        'true', 'false', 'cellmin', 'cellmax', 'char'
    ]);

    function stripTrailingSemicolon(source) {
        return String(source || '').trim().replace(/;\s*$/, '').trim();
    }

    function unwrapExpressionForValidation(expr, escapeChar = getActiveCtrlChar()) {
        let source = stripTrailingSemicolon(expr);
        while (source.startsWith('(')) {
            const unwrapped = unwrapOuterParens(source, escapeChar);
            if (unwrapped === source) break;
            source = unwrapped.trim();
        }
        return source;
    }

    function stripNamedArgumentPrefix(expr, escapeChar = getActiveCtrlChar()) {
        const source = unwrapExpressionForValidation(expr, escapeChar);
        const namedArg = semanticSyntaxCore.getRootNamedArgumentExpression(source, { escapeChar });
        return namedArg ? unwrapExpressionForValidation(namedArg.expression, escapeChar) : source;
    }

    function stripTagCastsForValidation(expr, escapeChar = getActiveCtrlChar()) {
        const source = stripNamedArgumentPrefix(expr, escapeChar);
        return unwrapExpressionForValidation(
            semanticSyntaxCore.stripRootTagCasts(source, { escapeChar }),
            escapeChar
        );
    }

    function isConstVariableDecl(decl) {
        return hasDeclModifier(decl, 'const');
    }

    function findVariableDeclByNameFromSources(decls = [], name = '', analysisCache = null) {
        const symbolName = String(name || '').trim();
        if (!symbolName) return null;
        if (analysisCache?.findVariableByName) {
            return analysisCache.findVariableByName(symbolName);
        }
        return findAnyDeclByNameFromSources(decls, symbolName, isVariableDecl, analysisCache);
    }

    function parseAssignableAccessExpression(expr, escapeChar = getActiveCtrlChar()) {
        const source = unwrapExpressionForValidation(expr, escapeChar);
        const indexedExpr = parseIndexedAccessExpression(source, escapeChar);
        if (!indexedExpr?.baseName || !indexedExpr.accesses?.length) return null;
        const accesses = indexedExpr.accesses.map(accessText => ({
            text: accessText,
            innerText: accessText.slice(1, -1).trim(),
            kind: accessText[0] === '{' ? '{' : '['
        }));
        if (accesses.some(access => !access.innerText)) return null;
        return { baseName: indexedExpr.baseName, accesses };
    }

    function getExpressionAssignableInfo(expr, decls = [], analysisCache = null, options = {}) {
        const escapeChar = options?.escapeChar ?? getActiveCtrlChar();
        const cacheKey = analysisCache?.assignableInfoByExpr
            ? `${escapeChar}\0${String(expr || '').trim()}`
            : '';
        if (cacheKey && analysisCache.assignableInfoByExpr.has(cacheKey)) {
            return analysisCache.assignableInfoByExpr.get(cacheKey);
        }
        const finish = result => {
            if (cacheKey) analysisCache.assignableInfoByExpr.set(cacheKey, result);
            return result;
        };
        const source = stripTagCastsForValidation(expr, escapeChar);
        if (!source) {
            return finish({ isLValue: false, isConst: false, dims: '', baseDecl: null, name: '', isIndexedAccess: false });
        }
        const expandedSource = expandExpressionMacrosForTypeInference(source, decls, analysisCache);
        if (expandedSource) {
            return finish(getExpressionAssignableInfo(expandedSource, decls, analysisCache, options));
        }

        const bareName = getPawnIdentifierName(source);
        if (bareName) {
            const decl = findVariableOrObjectAliasTargetDeclByNameFromSources(decls, bareName, analysisCache);
            if (!decl) {
                return finish({ isLValue: false, isConst: false, dims: '', baseDecl: null, name: bareName, isIndexedAccess: false });
            }
            const inferred = inferArgType(source, decls, analysisCache);
            return finish({
                isLValue: true,
                isConst: isConstVariableDecl(decl),
                dims: inferred?.dims || '',
                baseDecl: decl,
                name: bareName,
                isIndexedAccess: false
            });
        }

        const indexedExpr = parseAssignableAccessExpression(source, escapeChar);
        if (indexedExpr?.baseName) {
            const baseDecl = findVariableOrObjectAliasTargetDeclByNameFromSources(decls, indexedExpr.baseName, analysisCache);
            if (!baseDecl) {
                return finish({
                    isLValue: false,
                    isConst: false,
                    dims: '',
                    baseDecl: null,
                    name: indexedExpr.baseName,
                    isIndexedAccess: true
                });
            }
            const inferred = inferArgType(source, decls, analysisCache);
            let allowsScalarAssignmentToArrayField = false;
            if (inferred?.dims && indexedExpr.accesses?.length) {
                const accessChain = resolveIndexedAccessValidationChain(
                    baseDecl,
                    indexedExpr.accesses.map(access => access.innerText),
                    decls,
                    analysisCache
                );
                const lastStep = accessChain[accessChain.length - 1] || null;
                allowsScalarAssignmentToArrayField =
                    !!lastStep?.dimSpec?.enumName &&
                    Array.isArray(lastStep.nextDimParts) &&
                    lastStep.nextDimParts.length > 0;
            }
            return finish({
                isLValue: true,
                isConst: isConstVariableDecl(baseDecl),
                dims: inferred?.dims || '',
                baseDecl,
                name: indexedExpr.baseName,
                isIndexedAccess: true,
                allowsScalarAssignmentToArrayField
            });
        }

        return finish({ isLValue: false, isConst: false, dims: '', baseDecl: null, name: '', isIndexedAccess: false });
    }

    function isSyntacticAssignableExpression(expr, options = {}) {
        const escapeChar = options?.escapeChar ?? getActiveCtrlChar();
        const source = stripTagCastsForValidation(stripTrailingSemicolon(expr), escapeChar);
        if (!source) return false;
        if (semanticSyntaxCore.isNamedArgumentTarget(source, { escapeChar })) return true;
        return semanticSyntaxCore.isSyntacticAssignableExpression(source, { escapeChar }) ||
            !!parseIndexedAccessExpression(source, escapeChar);
    }

    function findFirstNonWhitespaceIndex(source, startIndex = 0) {
        return skipPawnWhitespace(source, startIndex);
    }

    function findPreviousNonWhitespaceIndex(source, startIndex = 0) {
        return findPreviousPawnNonWhitespaceIndex(source, startIndex);
    }

    function findBalancedGroupEnd(source, openIndex, openChar = '(', closeChar = ')', escapeChar = getActiveCtrlChar()) {
        return findBalancedGroupEndCore(source, openIndex, openChar, closeChar, {
            escapeChar,
            isEscapedQuote
        });
    }

    function hasUnclosedFunctionCallGroup(source, escapeChar = getActiveCtrlChar()) {
        const text = String(source || '');
        let inStr = false;
        let strCh = '';
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh && !isEscapedQuote(text, index, escapeChar)) inStr = false;
                continue;
            }
            if (char === '"' || char === "'") {
                inStr = true;
                strCh = char;
                continue;
            }
            if (!isIdentifierStartChar(char)) continue;
            const start = index;
            index++;
            while (index < text.length && isIdentifierContinueChar(text[index])) index++;
            const nextIndex = findFirstNonWhitespaceIndex(text, index);
            if (text[nextIndex] === '(') {
                const closeIndex = findBalancedGroupEnd(text, nextIndex, '(', ')', escapeChar);
                if (closeIndex < 0) return true;
                index = closeIndex;
                continue;
            }
            index = Math.max(start, index - 1);
        }
        return false;
    }

    function skipSizeofTagofOperand(source, index, escapeChar = getActiveCtrlChar()) {
        const text = String(source || '');
        let next = findFirstNonWhitespaceIndex(text, index);
        if (text[next] === '(') {
            const closeIndex = findBalancedGroupEnd(text, next, '(', ')', escapeChar);
            return closeIndex >= 0 ? closeIndex + 1 : next + 1;
        }
        if (!isIdentifierStartChar(text[next] || '')) return next;
        while (next < text.length && isIdentifierContinueChar(text[next])) next++;
        while (true) {
            next = findFirstNonWhitespaceIndex(text, next);
            if (text[next] !== '[') break;
            const closeIndex = findBalancedGroupEnd(text, next, '[', ']', escapeChar);
            if (closeIndex < 0) break;
            next = closeIndex + 1;
        }
        return next;
    }

    function readIndexedAccessEnd(source, index, escapeChar = getActiveCtrlChar()) {
        const text = String(source || '');
        let end = index;
        while (true) {
            const accessStart = findFirstNonWhitespaceIndex(text, end);
            const openChar = text[accessStart];
            const closeChar = openChar === '['
                ? ']'
                : (openChar === '{' ? '}' : '');
            if (!closeChar) break;
            const closeIndex = findBalancedGroupEnd(text, accessStart, openChar, closeChar, escapeChar);
            if (closeIndex < 0) break;
            end = closeIndex + 1;
        }
        return end;
    }

    function mayContainArrayScalarExpressionUse(source, escapeChar = getActiveCtrlChar()) {
        const text = String(source || '');
        if (!containsPawnIdentifierStartChar(text)) return false;
        let inStr = false;
        let strCh = 0;
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            if (inStr) {
                if (code === strCh && !isEscapedQuote(text, index, escapeChar)) inStr = false;
                continue;
            }
            if (code === 34 || code === 39) {
                inStr = true;
                strCh = code;
                continue;
            }
            if (
                code === 33 || code === 37 || code === 38 || code === 42 ||
                code === 43 || code === 45 || code === 47 || code === 58 ||
                code === 60 || code === 62 || code === 63 || code === 94 ||
                code === 124 || code === 126
            ) {
                return true;
            }
        }
        return false;
    }

    function findArrayMustBeIndexedIssueInScalarExpression(expr, decls = [], analysisCache = null, options = {}) {
        const escapeChar = options?.escapeChar ?? getActiveCtrlChar();
        const text = String(expr || '');
        if (!text || !mayContainArrayScalarExpressionUse(text, escapeChar)) return null;

        let inStr = false;
        let strCh = '';
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh && !isEscapedQuote(text, index, escapeChar)) inStr = false;
                continue;
            }
            if (char === '"' || char === "'") {
                inStr = true;
                strCh = char;
                continue;
            }
            if (!isIdentifierStartChar(char)) continue;

            const identStart = index;
            index++;
            while (index < text.length && isIdentifierContinueChar(text[index])) index++;
            const name = text.slice(identStart, index);
            index--;

            if (arrayScalarIgnoredNames.has(name)) {
                if (name === 'tagof' || name === 'sizeof') {
                    index = Math.max(index, skipSizeofTagofOperand(text, index + 1, escapeChar) - 1);
                }
                continue;
            }

            const previousIndex = findPreviousNonWhitespaceIndex(text, identStart - 1);
            const nextIndex = findFirstNonWhitespaceIndex(text, index + 1);
            const previousChar = previousIndex >= 0 ? text[previousIndex] : '';
            const nextChar = nextIndex < text.length ? text[nextIndex] : '';
            if (nextChar === ':') continue;
            if (previousChar === '.') continue;
            if (nextChar === '(') {
                const closeIndex = findBalancedGroupEnd(text, nextIndex, '(', ')', escapeChar);
                if (closeIndex >= 0) index = closeIndex;
                continue;
            }

            const decl = findVariableDeclByNameFromSources(decls, name, analysisCache);
            if (!decl?.dims) continue;

            const accessEnd = readIndexedAccessEnd(text, index + 1, escapeChar);
            const accessSource = text.slice(identStart, accessEnd).trim();
            const accessType = inferArgType(accessSource, decls, analysisCache);
            if (accessType?.dims) return { name };
            index = Math.max(index, accessEnd - 1);
        }

        return null;
    }

    function findArrayMustBeIndexedIssue(expr, decls = [], analysisCache = null, options = {}) {
        const escapeChar = options?.escapeChar ?? getActiveCtrlChar();
        const source = stripTagCastsForValidation(expr, escapeChar);
        if (!source) return null;
        if (!containsPawnIdentifierStartChar(source)) return null;
        if (hasUnclosedFunctionCallGroup(source, escapeChar)) return null;

        const inferred = inferArgType(source, decls, analysisCache);
        if (inferred?.dims) {
            const bareName = getPawnIdentifierName(source);
            if (bareName && findVariableDeclByNameFromSources(decls, bareName, analysisCache)?.dims) {
                return { name: bareName };
            }

            const indexedExpr = parseIndexedAccessExpression(source, escapeChar);
            if (indexedExpr?.baseName) {
                const baseDecl = findVariableDeclByNameFromSources(decls, indexedExpr.baseName, analysisCache);
                if (baseDecl?.dims) return { name: indexedExpr.baseName };
            }
        }

        return findArrayMustBeIndexedIssueInScalarExpression(source, decls, analysisCache, { escapeChar });
    }

    function inferArrayShapeActualType(expr, decls = [], analysisCache = null) {
        const inferred = inferArgType(expr, decls, analysisCache) || { tag: '', dims: '' };
        if (inferred.dims) {
            return { type: inferred, callReturn: null };
        }
        const callReturn = inferCallReturnType(expr, decls, analysisCache);
        return callReturn?.known
            ? { type: { tag: callReturn.tag || inferred.tag || '', dims: callReturn.dims || '' }, callReturn }
            : { type: inferred, callReturn: null };
    }

    function expandFunctionLikeDefineCall(decl, argsText = '', escapeChar = getActiveCtrlChar()) {
        return macroExpansionCore.expandFunctionLikeDefineCall(decl, argsText, {
            escapeChar,
            expandActualArgs: false
        });
    }

    function getRootTagCastExpressionForValidation(expr, escapeChar = getActiveCtrlChar()) {
        let source = unwrapOuterParens(expr);
        if (!source) return null;
        const namedArg = semanticSyntaxCore.getRootNamedArgumentExpression(source, { escapeChar });
        if (namedArg) source = unwrapOuterParens(namedArg.expression);
        return semanticSyntaxCore.getRootTagCastExpression(source, { escapeChar });
    }

    function expandExpressionMacrosForTypeInference(expr, decls = [], analysisCache = null, disabledNames = new Set()) {
        const source = String(expr || '').trim();
        if (!source || source.length > 512 || !containsPawnIdentifierStartChar(source)) return '';
        const findDefineForMacroExpansion = name => {
            const key = String(name || '');
            if (!key) return null;
            const cache = analysisCache?.macroDefineByName;
            if (cache?.has(key)) return cache.get(key);
            const decl = analysisCache?.findDefineByName
                ? analysisCache.findDefineByName(key)
                : findAnyDeclByNameFromSources(
                    decls,
                    key,
                    item => item.type === 'define',
                    analysisCache
                );
            const result = decl?.type === 'define' ? decl : null;
            cache?.set(key, result);
            return result;
        };
        const expanded = macroExpansionCore.expandMacros(source, decls, {
            escapeChar: getActiveCtrlChar(),
            disabledNames,
            getDefine: findDefineForMacroExpansion,
            maxInputLength: 512,
            maxOutputLength: 2048
        });
        if (!expanded.complete || !expanded.changed) return '';
        const expandedText = String(expanded.text || '').trim();
        return expandedText && expandedText !== source ? expandedText : '';
    }

    function lineHasFunctionBodyHeader(rawLines = [], lineNumber = 0, headerRe = null, escapeChar = getActiveCtrlChar()) {
        if (!headerRe || lineNumber < 0 || lineNumber >= rawLines.length) return false;
        const lineText = String(rawLines[lineNumber] || '');
        const headerMatch = headerRe.exec(lineText);
        if (!headerMatch) return false;
        const prefix = lineText.slice(0, headerMatch.index);
        if (/[\#,(=]/.test(prefix)) return false;
        const combined = rawLines.slice(lineNumber, Math.min(rawLines.length, lineNumber + 10)).join('\n');
        const openParenIndex = combined.indexOf('(', headerMatch.index);
        if (openParenIndex < 0) return false;
        const closeParenIndex = findBalancedGroupEnd(combined, openParenIndex, '(', ')', escapeChar);
        if (closeParenIndex < 0) return false;
        const braceIndex = combined.indexOf('{', closeParenIndex + 1);
        const semicolonIndex = combined.indexOf(';', closeParenIndex + 1);
        return braceIndex >= 0 && (semicolonIndex < 0 || braceIndex < semicolonIndex);
    }

    function resolveFunctionHeaderStartOffset(text, rawLines = null, startLine = 0, headerRe = null, escapeChar = getActiveCtrlChar()) {
        const safeStartLine = Math.max(0, Number.isInteger(startLine) ? startLine : 0);
        if (!Array.isArray(rawLines) || !rawLines.length) {
            return getTextLineStartOffset(text, safeStartLine);
        }

        const boundedStartLine = Math.min(rawLines.length - 1, safeStartLine);
        for (let probe = boundedStartLine; probe < Math.min(rawLines.length, boundedStartLine + 6); probe++) {
            if (lineHasFunctionBodyHeader(rawLines, probe, headerRe, escapeChar)) {
                return getTextLineStartOffset(text, probe);
            }
        }

        let bestLine = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let probe = 0; probe < rawLines.length; probe++) {
            if (!lineHasFunctionBodyHeader(rawLines, probe, headerRe, escapeChar)) continue;
            const distance = Math.abs(probe - boundedStartLine);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestLine = probe;
                if (distance === 0) break;
            }
        }

        return getTextLineStartOffset(text, bestLine >= 0 ? bestLine : boundedStartLine);
    }

    function inferFunctionDeclReturnType(decl, allDecls, analysisCache = null) {
        if (!decl?.filePath || !Number.isInteger(decl.lineNumber) || !fs?.readFileSync) {
            return { tag: '', dims: '' };
        }
        if (functionReturnTypeCache.has(decl)) {
            return functionReturnTypeCache.get(decl);
        }

        const fallback = { tag: '', dims: '', known: false };
        const knownScalar = { tag: '', dims: '', known: true };
        const cacheFunctionReturnTypeResult = result => {
            functionReturnTypeCache.set(decl, result);
            return result;
        };

        try {
            const analysisSourcePath = normalizeCachePath(analysisCache?.sourceFilePath || '');
            const declPath = normalizeCachePath(decl.filePath);
            const cachedSourceText = analysisSourcePath && analysisSourcePath === declPath
                ? String(analysisCache?.sourceText || '')
                : '';
            const cachedRawLines = cachedSourceText && Array.isArray(analysisCache?.sourceRawLines)
                ? analysisCache.sourceRawLines
                : null;
            const openDocument = cachedSourceText ? null : getOpenDocumentForFile(decl.filePath);
            const stat = (cachedSourceText || openDocument) ? null : fs.statSync?.(decl.filePath);
            const stableCacheKey = stat
                ? [
                    decl.filePath,
                    decl.lineNumber,
                    decl.name,
                    Number(stat.mtimeMs || 0),
                    Number(stat.size || 0)
                ].join('|')
                : '';
            if (stableCacheKey && functionReturnTypeStableCache.has(stableCacheKey)) {
                return cacheFunctionReturnTypeResult(functionReturnTypeStableCache.get(stableCacheKey));
            }
            const text = cachedSourceText || (openDocument
                ? String(openDocument.getText?.() || '')
                : String(fs.readFileSync(decl.filePath, 'utf8') || ''));
            if (!text) return cacheFunctionReturnTypeResult(fallback);
            const headerRe = new RegExp(`\\b${escapeRegExp(decl.name)}\\s*\\(`);
            const startLine = Math.max(0, Number.isInteger(decl.lineNumber) ? decl.lineNumber : 0);
            const rawLines = cachedRawLines?.length ? cachedRawLines : text.split(/\r?\n/);
            const headerStartOffset = resolveFunctionHeaderStartOffset(
                text,
                rawLines,
                startLine,
                headerRe,
                getActiveCtrlChar()
            );

            const sourceFromHeader = text.slice(headerStartOffset);
            const bodyOpenRelative = sourceFromHeader.indexOf('{');
            if (bodyOpenRelative < 0) return cacheFunctionReturnTypeResult(fallback);

            let depth = 0;
            let bodyCloseRelative = -1;
            let inStr = false;
            let strCh = '';
            for (let index = bodyOpenRelative; index < sourceFromHeader.length; index++) {
                const char = sourceFromHeader[index];
                if (inStr) {
                    if (char === strCh && !isEscapedQuote(sourceFromHeader, index, getActiveCtrlChar())) inStr = false;
                    continue;
                }
                if (char === '"' || char === "'") {
                    inStr = true;
                    strCh = char;
                    continue;
                }
                if (char === '{') depth++;
                else if (char === '}') {
                    depth--;
                    if (depth === 0) {
                        bodyCloseRelative = index;
                        break;
                    }
                }
            }
            if (bodyCloseRelative < 0) return cacheFunctionReturnTypeResult(fallback);

            const bodyText = sourceFromHeader.slice(bodyOpenRelative + 1, bodyCloseRelative);
            const localArrayDimsByName = new Map();
            for (const paramText of splitTopLevel(decl.args || '')) {
                const paramMeta = parseParamMeta(paramText);
                if (paramMeta.name && paramMeta.expectedDims) {
                    localArrayDimsByName.set(paramMeta.name, paramMeta.expectedDims);
                }
            }
            const localArrayDeclRe = /\b(?:new|static)\s+([A-Za-z_@]\w*)\s*((?:\[[^\]]+\])+)/g;
            let localMatch = null;
            while ((localMatch = localArrayDeclRe.exec(bodyText))) {
                localArrayDimsByName.set(localMatch[1], localMatch[2]);
            }

            const returnTypes = [];
            const returnRe = /^\s*return\b([^\r\n;]*)(?:;)?\s*$/gm;
            let returnMatch = null;
            while ((returnMatch = returnRe.exec(bodyText))) {
                const returnExpr = String(returnMatch[1] || '').trim();
                if (!returnExpr) continue;
                const localDims = localArrayDimsByName.get(returnExpr);
                if (localDims) {
                    returnTypes.push({ tag: '', dims: localDims });
                    continue;
                }
                returnTypes.push(inferArgType(returnExpr, allDecls, analysisCache));
            }

            const resolved = returnTypes.find(item => item?.tag || item?.dims) || knownScalar;
            const consistent = returnTypes.every(item =>
                (item?.tag || '') === (resolved.tag || '') &&
                (item?.dims || '') === (resolved.dims || '')
            );
            const result = consistent ? { ...resolved, known: true } : fallback;
            if (stableCacheKey) {
                functionReturnTypeStableCache.set(stableCacheKey, result);
            }
            return cacheFunctionReturnTypeResult(result);
        } catch {
            return cacheFunctionReturnTypeResult(fallback);
        }
    }

    function inferCallReturnType(expr, decls = [], analysisCache = null, seenExprs = null) {
        const source = String(expr || '').trim();
        if (!source || seenExprs?.has(source)) return null;
        if (analysisCache?.callReturnTypeByExpr?.has(source)) {
            return analysisCache.callReturnTypeByExpr.get(source);
        }
        if (!seenExprs) seenExprs = new Set();
        seenExprs.add(source);
        const cacheCallReturnTypeResult = result => {
            if (analysisCache?.callReturnTypeByExpr) {
                analysisCache.callReturnTypeByExpr.set(source, result);
            }
            return result;
        };

        const callExpr = parseWholeCallExpression(source);
        if (!callExpr) return cacheCallReturnTypeResult(null);

        const decl = findFunctionLikeOrObjectAliasTargetDeclByNameFromSources(
            decls,
            callExpr.name,
            analysisCache
        );
        if (!decl) return cacheCallReturnTypeResult(null);

        if (decl.type === 'define' && decl.macroStyle === 'paren') {
            const expandedDefineValue = expandFunctionLikeDefineCall(
                decl,
                callExpr.argsText,
                getActiveCtrlChar()
            );
            if (!expandedDefineValue || expandedDefineValue === source) return cacheCallReturnTypeResult(null);
            return cacheCallReturnTypeResult(inferCallReturnType(expandedDefineValue, decls, analysisCache, seenExprs));
        }

        if (decl.dims) {
            return cacheCallReturnTypeResult({
                known: true,
                tag: decl.typeTag || '',
                dims: decl.dims || '',
                decl
            });
        }

        const hasSourceBody = !!decl.filePath && Number.isInteger(decl.lineNumber);
        const inferredReturnType = hasSourceBody
            ? inferFunctionDeclReturnType(decl, decls, analysisCache)
            : { tag: decl.typeTag || '', dims: '', known: true };
        return cacheCallReturnTypeResult({
            known: inferredReturnType?.known !== false,
            tag: inferredReturnType?.tag || decl.typeTag || '',
            dims: inferredReturnType?.dims || '',
            decl
        });
    }

    function inferArrayLikeCallReturnType(expr, decls = [], analysisCache = null, seenExprs = null) {
        const inferred = inferCallReturnType(expr, decls, analysisCache, seenExprs);
        return inferred?.dims
            ? inferred
            : null;
    }

    function getEnumItemExpressionTag(decl) {
        if (!decl || decl.type !== 'enum-item') return '';
        if (decl.typeTag) return decl.typeTag;
        const enumName = String(decl.enumName || '').trim();
        const taggedEnum = enumName.match(/^([A-Za-z_@]\w*|_)\s*:\s*([A-Za-z_@]\w*)$/);
        if (taggedEnum) {
            return taggedEnum[1] === '_' ? '' : taggedEnum[1];
        }
        return normalizeEnumName(enumName);
    }

    function inferEnumItemType(decl) {
        if (!decl || decl.type !== 'enum-item') return null;
        const enumName = String(decl.enumName || '').trim();
        const carriesFieldType = !!decl.dims || /^_\s*:/.test(enumName);
        return {
            tag: carriesFieldType ? '' : getEnumItemExpressionTag(decl),
            dims: ''
        };
    }

    function splitTopLevelBinaryExpression(source, escapeChar = getActiveCtrlChar()) {
        return semanticSyntaxCore.flattenRootBinaryExpression(source, {
            escapeChar,
            allowAssignment: false
        });
    }

    const BINARY_BOOL_OPERATORS = new Set(['&&', '||', '<', '<=', '>', '>=', '==', '!=']);
    const POTENTIAL_BINARY_OPERATOR_RE = /&&|\|\||==|!=|<=|>=|<<|>>|[+\-*\/%<>&|^]/;

    function inferTopLevelBinaryExprType(source, allDecls, analysisCache) {
        if (!POTENTIAL_BINARY_OPERATOR_RE.test(String(source || ''))) return null;
        const binaryExpr = splitTopLevelBinaryExpression(source);
        if (!binaryExpr) return null;
        if (binaryExpr.operators.some(op => BINARY_BOOL_OPERATORS.has(op))) {
            return { tag: 'bool', dims: '' };
        }
        const operandTypes = binaryExpr.parts.map(part => inferArgType(part, allDecls, analysisCache));
        if (operandTypes.some(type => type?.dims)) {
            return { tag: '', dims: '' };
        }
        if (operandTypes.some(type => String(type?.tag || '') === 'Float')) {
            return { tag: 'Float', dims: '' };
        }
        const firstTagged = operandTypes.find(type => type?.tag)?.tag || '';
        if (firstTagged && operandTypes.every(type => !type?.tag || type.tag === firstTagged)) {
            return { tag: firstTagged, dims: '' };
        }
        return { tag: '', dims: '' };
    }

    function isPotentialRootUnaryExpression(source) {
        const text = String(source || '').trim();
        if (!text) return false;
        if (text.startsWith('++') || text.startsWith('--')) return true;
        if (text[0] === '+' || text[0] === '-' || text[0] === '!' || text[0] === '~') return true;
        for (const keyword of ['sizeof', 'tagof', 'defined', 'char']) {
            if (
                text.startsWith(keyword) &&
                !isIdentifierContinueChar(text[keyword.length] || '')
            ) {
                return true;
            }
        }
        return false;
    }

    function inferArgType(expr, allDecls, analysisCache = null) {
        const cacheKey = String(expr || '').trim();
        if (analysisCache?.argTypeByExpr.has(cacheKey)) {
            return analysisCache.argTypeByExpr.get(cacheKey);
        }
        if (analysisCache?.inferInProgressByExpr.has(cacheKey)) {
            return { tag: '', dims: '' };
        }

        const cacheArgTypeResult = result => {
            if (analysisCache) analysisCache.argTypeByExpr.set(cacheKey, result);
            return result;
        };
        analysisCache?.inferInProgressByExpr.add(cacheKey);
        const finish = result => {
            analysisCache?.inferInProgressByExpr.delete(cacheKey);
            return cacheArgTypeResult(result);
        };
        let s = unwrapOuterParens(expr);
        if (!s) return finish({ tag: '', dims: '' });
        const namedArg = semanticSyntaxCore.getRootNamedArgumentExpression(s, { escapeChar: getActiveCtrlChar() });
        if (namedArg) s = unwrapOuterParens(namedArg.expression);
        if (s === '_') return finish({ tag: '', dims: '', isDefaultPlaceholder: true });
        const rootTagCast = semanticSyntaxCore.getRootTagCastExpression(s, { escapeChar: getActiveCtrlChar() });
        if (rootTagCast?.tag === '_') {
            const underlying = inferArgType(rootTagCast.expression, allDecls, analysisCache);
            return finish({
                ...underlying,
                tag: ''
            });
        }
        if (isPotentialRootUnaryExpression(s)) {
            const semanticExpr = semanticSyntaxCore.parsePawnExpression(s, {
                escapeChar: getActiveCtrlChar(),
                buildAst: true,
                allowAssignment: false
            });
            if (semanticExpr.ok && semanticExpr.ast?.kind === 'unary') {
                const operand = semanticSyntaxCore.getNodeSource(s, semanticExpr.ast.expr);
                const underlying = inferArgType(operand, allDecls, analysisCache);
                if (semanticExpr.ast.operator === '!') return finish({ tag: 'bool', dims: '' });
                if (
                    semanticExpr.ast.operator === '~' ||
                    semanticExpr.ast.operator === 'sizeof' ||
                    semanticExpr.ast.operator === 'tagof' ||
                    semanticExpr.ast.operator === 'defined' ||
                    semanticExpr.ast.operator === 'char'
                ) {
                    return finish({ tag: '', dims: '' });
                }
                return finish(underlying);
            }
        }
        const ternaryExpr = s.includes('?')
            ? semanticSyntaxCore.parseTopLevelTernaryExpression(s, {
                escapeChar: getActiveCtrlChar()
            })
            : null;
        if (ternaryExpr) {
            const whenTrue = inferArgType(ternaryExpr.whenTrue, allDecls, analysisCache);
            const whenFalse = inferArgType(ternaryExpr.whenFalse, allDecls, analysisCache);
            if (whenTrue.tag === whenFalse.tag && whenTrue.dims === whenFalse.dims) {
                return finish(whenTrue);
            }
            if (whenTrue.dims && whenFalse.dims) {
                const trueDepth = (whenTrue.dims.match(/\[/g) || []).length;
                const falseDepth = (whenFalse.dims.match(/\[/g) || []).length;
                if (trueDepth === falseDepth) {
                    return finish({
                        tag: whenTrue.tag === whenFalse.tag
                            ? whenTrue.tag
                            : (
                                (whenTrue.tag === '_' && !whenFalse.tag) ||
                                (whenFalse.tag === '_' && !whenTrue.tag)
                            )
                                ? '_'
                                : '',
                        dims: '[]'.repeat(trueDepth),
                        elementTag: whenTrue.elementTag === whenFalse.elementTag
                            ? (whenTrue.elementTag || '')
                            : ''
                    });
                }
            }
            if (whenTrue.dims && whenTrue.dims === whenFalse.dims) {
                return finish({
                    tag: whenTrue.tag === whenFalse.tag ? whenTrue.tag : '',
                    dims: whenTrue.dims
                });
            }
            return finish({ tag: '', dims: '' });
        }
        if (s.includes('=')) {
            const assignmentExpr = semanticSyntaxCore.parsePawnExpression(s, {
                escapeChar: getActiveCtrlChar(),
                buildAst: true,
                allowAssignment: true
            });
            if (assignmentExpr.ok && assignmentExpr.ast?.kind === 'assignment') {
                const lhs = semanticSyntaxCore.getNodeSource(s, assignmentExpr.ast.left);
                const rhs = semanticSyntaxCore.getNodeSource(s, assignmentExpr.ast.right);
                const lhsType = inferArgType(lhs, allDecls, analysisCache);
                if (lhsType?.tag || lhsType?.dims) return finish(lhsType);
                return finish(inferArgType(rhs, allDecls, analysisCache));
            }
        }
        const taggedBraceArray = s.match(/^([A-Za-z_@]\w*)\s*:\s*(\{[\s\S]*\})$/);
        if (taggedBraceArray && !FORBIDDEN.has(taggedBraceArray[1])) {
            const braceArray = parseBraceArrayLiteralExpression(taggedBraceArray[2]);
            if (braceArray) {
                const elementTypes = braceArray.map(part => inferArgType(part, allDecls, analysisCache));
                const firstResolved = elementTypes.find(item => item.tag || item.dims) || { tag: '', dims: '' };
                const sameDims = elementTypes.every(item => item.dims === firstResolved.dims);
                const firstElementTag = taggedBraceArray[1] || '';
                return finish({
                    tag: taggedBraceArray[1],
                    dims: `[${braceArray.length}]${sameDims ? firstResolved.dims : ''}`,
                    elementTag: firstElementTag
                });
            }
        }
        const braceArray = parseBraceArrayLiteralExpression(s);
        if (braceArray) {
            const elementTypes = braceArray.map(part => inferArgType(part, allDecls, analysisCache));
            const firstResolved = elementTypes.find(item => item.tag || item.dims) || { tag: '', dims: '' };
            const sameDims = elementTypes.every(item => item.dims === firstResolved.dims);
            const firstTaggedElement = elementTypes.find(item => item.elementTag || item.tag) || null;
            const firstElementTag = firstTaggedElement?.elementTag || firstTaggedElement?.tag || '';
            const sameElementTag = firstElementTag
                ? elementTypes.every(item =>
                    normalizeTagName(item.elementTag || item.tag || '') === normalizeTagName(firstElementTag)
                )
                : false;
            return finish({
                tag: '',
                dims: `[${braceArray.length}]${sameDims ? firstResolved.dims : ''}`,
                elementTag: sameElementTag ? firstElementTag : ''
            });
        }
        if (s.startsWith('"')) return finish({ tag: '_', dims: '[]' });
        if (s.startsWith("'")) return finish({ tag: '', dims: '' });
        if (/^-?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return finish({ tag: 'Float', dims: '' });
        if (s === 'true' || s === 'false') return finish({ tag: 'bool', dims: '' });
        const tagCastExpr = rootTagCast || semanticSyntaxCore.getRootTagCastExpression(s, { escapeChar: getActiveCtrlChar() });
        if (tagCastExpr && !FORBIDDEN.has(tagCastExpr.tag)) {
            const underlying = inferArgType(tagCastExpr.expression, allDecls, analysisCache);
            return finish({
                ...underlying,
                tag: tagCastExpr.tag
            });
        }

        const earlyBinaryType = inferTopLevelBinaryExprType(s, allDecls, analysisCache);
        if (earlyBinaryType) return finish(earlyBinaryType);

        if (
            s === 'cellmin' ||
            s === 'cellmax' ||
            (!/^[A-Za-z_@]\w*$/.test(s) && evaluatePawnNumericExpr(s, allDecls, null, analysisCache) != null)
        ) {
            return finish({ tag: '', dims: '' });
        }

        const callExpr = parseWholeCallExpression(s);
        if (callExpr) {
            const decl = findFunctionLikeOrObjectAliasTargetDeclByNameFromSources(
                allDecls,
                callExpr.name,
                analysisCache
            );
            if (decl) {
                if (decl.type === 'define' && decl.macroStyle === 'paren') {
                    const expandedDefineValue = expandFunctionLikeDefineCall(
                        decl,
                        callExpr.argsText,
                        getActiveCtrlChar()
                    );
                    if (expandedDefineValue) {
                        return finish(inferArgType(expandedDefineValue, allDecls, analysisCache));
                    }
                }
                return finish({ tag: decl.typeTag || '', dims: decl.dims || '' });
            }
        }

        const indexedBase = parseIndexedAccessExpression(s);
        if (indexedBase) {
            const decl = findVariableOrObjectAliasTargetDeclByNameFromSources(
                allDecls,
                indexedBase.baseName,
                analysisCache
            );
            if (decl) {
                const accessChain = resolveIndexedAccessValidationChain(
                    decl,
                    indexedBase.accesses.map(access => access.slice(1, -1).trim()),
                    allDecls,
                    analysisCache
                );
                const lastStep = accessChain[accessChain.length - 1] || null;
                const remainingDimParts = lastStep?.nextDimParts || [];
                const resultTag = lastStep?.nextTag || decl.typeTag || '';
                const remainingDims = remainingDimParts.map(part => `[${part}]`).join('');
                return finish({ tag: resultTag, dims: remainingDims });
            }
        }

        if (isPawnIdentifierName(s)) {
            const builtinDecl = findAnyDeclByNameFromSources(
                allDecls,
                s,
                item => item.type === 'builtin',
                analysisCache
            );
            const builtinTypeInfo = getCompilerBuiltinTypeInfo(builtinDecl);
            if (builtinTypeInfo) {
                return finish(builtinTypeInfo);
            }

            const decl = findLocalDeclByNameFromSources(
                allDecls,
                s,
                item => item.type === 'variable',
                analysisCache
            );
            if (decl) {
                const dims = getEffectiveDeclDimParts(decl).map(part => `[${part}]`).join('');
                return finish({ tag: decl.typeTag || '', dims });
            }

            const enumItemDecl = findAnyDeclByNameFromSources(
                allDecls,
                s,
                item => item.type === 'enum-item',
                analysisCache
            );
            const enumItemType = inferEnumItemType(enumItemDecl);
            if (enumItemType) {
                return finish(enumItemType);
            }

            const defineDecl = findAnyDeclByNameFromSources(
                allDecls,
                s,
                item => item.type === 'define' && !item.args,
                analysisCache
            );
            if (defineDecl) {
                const defineValue = String(defineDecl.value || '').trim();
                const aliasTargetName = getPawnIdentifierName(defineValue);
                if (aliasTargetName && aliasTargetName !== s) {
                    return finish(inferArgType(aliasTargetName, allDecls, analysisCache));
                }
                if (defineValue) {
                    return finish(inferArgType(defineValue, allDecls, analysisCache));
                }
            }
        }
        if (evaluatePawnNumericExpr(s, allDecls, null, analysisCache) != null) {
            return finish({ tag: '', dims: '' });
        }
        const expandedTypeSource = expandExpressionMacrosForTypeInference(s, allDecls, analysisCache);
        if (expandedTypeSource) {
            return finish(inferArgType(expandedTypeSource, allDecls, analysisCache));
        }
        return finish({ tag: '', dims: '' });
    }

    function inferEffectiveDimPartsFromValue(baseDimParts, value, escapeChar = getActiveCtrlChar()) {
        return arrayShapeCore.inferEffectiveDimPartsFromValue(baseDimParts, value, { escapeChar });
    }

    function getEffectiveDeclDimParts(decl) {
        if (!decl?.dims) return [];
        if (effectiveDeclDimPartsCache.has(decl)) {
            return effectiveDeclDimPartsCache.get(decl);
        }

        const baseDimParts = parseDimsParts(decl.dims || '');
        const resolvedDimParts = decl.type === 'variable' && decl.value
            ? inferEffectiveDimPartsFromValue(baseDimParts, decl.value)
            : baseDimParts;
        effectiveDeclDimPartsCache.set(decl, resolvedDimParts);
        return resolvedDimParts;
    }

    function getEnumItemCellSpan(memberDecl, allDecls = [], analysisCache = null) {
        if (!memberDecl || memberDecl.type !== 'enum-item') return 1;
        const memberDimParts = getEffectiveDeclDimParts(memberDecl);
        if (!memberDimParts.length) return 1;

        let span = 1;
        for (const part of memberDimParts) {
            const spec = analysisCache?.getDimSpec(part) ||
                parseDimSpec(part, allDecls, null, analysisCache);
            if (spec?.capacity == null) return null;
            span *= spec.capacity;
        }
        return span;
    }

    function getEnumDeclResolvedCapacity(enumDecl, decls = [], seen = null, analysisCache = null) {
        if (!enumDecl || enumDecl.type !== 'enum') return null;
        const enumKey = `enum:${normalizeEnumName(enumDecl.name || enumDecl.enumName || '')}`;
        if (seen?.has(enumKey)) return null;
        const localSeen = seen || new Set();
        localSeen.add(enumKey);

        let maxEnd = null;
        for (const memberDecl of enumDecl.enumMembers || []) {
            const start = evaluatePawnNumericExpr(
                String(memberDecl?.value ?? '').trim(),
                decls,
                localSeen,
                analysisCache
            );
            if (start == null || start < 0) continue;

            let span = 1;
            for (const part of getEffectiveDeclDimParts(memberDecl)) {
                const spec = parseDimSpec(part, decls, localSeen, analysisCache);
                if (spec?.capacity == null) {
                    span = null;
                    break;
                }
                span *= Math.max(1, spec.capacity);
            }
            if (span == null) continue;
            maxEnd = Math.max(maxEnd ?? 0, start + Math.max(1, span));
        }

        localSeen.delete(enumKey);
        return maxEnd;
    }

    function resolveIndexedAccessValidationChain(baseDecl, accesses = [], allDecls = [], analysisCache = null) {
        if (!baseDecl) return [];

        let currentTag = baseDecl.typeTag || '';
        let currentDimParts = getEffectiveDeclDimParts(baseDecl);
        const steps = [];
        const sameDimParts = (left = [], right = []) =>
            left.length === right.length && left.every((part, index) => part === right[index]);
        const canTreatEnumSizedAccessAsScalarIndex = (expr, expectedEnumName = '') => {
            const source = String(expr || '').trim();
            if (!source) return false;

            if (evaluatePawnNumericExpr(source, allDecls, null, analysisCache) != null) {
                return true;
            }

            const bareName = getPawnIdentifierName(source);
            if (bareName) {
                const bareDecl = findAnyDeclByNameFromSources(allDecls, bareName, null, analysisCache);
                if (bareDecl?.type === 'enum-item') {
                    return !!expectedEnumName && normalizeEnumName(bareDecl.enumName) === normalizeEnumName(expectedEnumName);
                }
                if (bareDecl && bareDecl.type === 'variable' && !bareDecl.dims) {
                    const bareTag = String(bareDecl.typeTag || '').toLowerCase();
                    return bareTag !== 'float';
                }
            }

            const actualType = inferArgType(source, allDecls, analysisCache);
            if (actualType?.dims) return false;
            const actualTag = String(actualType?.tag || '').toLowerCase();
            return actualTag !== 'float';
        };
        const resolveEnumMemberBranch = (expr, enumName) => {
            const source = String(expr || '').trim();
            const ternaryExpr = semanticSyntaxCore.parseTopLevelTernaryExpression(source, {
                escapeChar: getActiveCtrlChar()
            });
            if (ternaryExpr) {
                const whenTrue = resolveEnumMemberBranch(ternaryExpr.whenTrue, enumName);
                const whenFalse = resolveEnumMemberBranch(ternaryExpr.whenFalse, enumName);
                if (!whenTrue || !whenFalse) return null;
                return {
                    nextTag: whenTrue.nextTag === whenFalse.nextTag ? whenTrue.nextTag : '',
                    nextDimParts: sameDimParts(whenTrue.nextDimParts, whenFalse.nextDimParts)
                        ? whenTrue.nextDimParts
                        : []
                };
            }

            const memberName = getPawnIdentifierName(source);
            if (!memberName) return null;

            const enumDecl = findLocalDeclByNameFromSources(
                allDecls,
                enumName,
                item => item.type === 'enum',
                analysisCache
            );
            const memberDecl = enumDecl?.enumMembers?.find(item => item.name === memberName) ||
                findLocalDeclByNameFromSources(
                    allDecls,
                    memberName,
                    item => item.type === 'enum-item' && normalizeEnumName(item.enumName) === normalizeEnumName(enumName),
                    analysisCache
                );
            if (!memberDecl) return null;

            return {
                nextTag: memberDecl.typeTag || '',
                nextDimParts: getEffectiveDeclDimParts(memberDecl)
            };
        };
        const getExplicitEnumItemCellTag = expr => {
            const memberName = getPawnIdentifierName(expr);
            if (!memberName) return '';
            const memberDecl = findAnyDeclByNameFromSources(
                allDecls,
                memberName,
                item => item.type === 'enum-item',
                analysisCache
            );
            return memberDecl?.typeTag || '';
        };
        const resolveNumericDimensionEnumField = (expr, dimSpec) => {
            if (dimSpec?.capacity == null) return null;
            const memberName = getPawnIdentifierName(expr);
            if (!memberName) return null;

            const memberDecl = findAnyDeclByNameFromSources(
                allDecls,
                memberName,
                item => item.type === 'enum-item',
                analysisCache
            );
            if (!memberDecl?.dims) return null;

            const offset = evaluatePawnNumericExpr(memberName, allDecls, null, analysisCache);
            const span = getEnumItemCellSpan(memberDecl, allDecls, analysisCache);
            if (offset == null || span == null || offset < 0) return null;
            if (offset + span > dimSpec.capacity) return null;

            return memberDecl;
        };

        for (const accessText of accesses) {
            const actualExpr = String(accessText || '').trim();
            const expectedDimPart = currentDimParts.length ? currentDimParts[0] : null;
            const dimSpec = expectedDimPart != null
                ? (analysisCache?.getDimSpec(expectedDimPart) || parseDimSpec(expectedDimPart, allDecls, null, analysisCache))
                : null;
            const enumName = dimSpec?.enumName || '';
            const selectedSourceDimParts = [...currentDimParts];

            const step = {
                tag: currentTag,
                expectedDimPart,
                dimSpec,
                remainingDimParts: [...currentDimParts],
                selectedSourceDimParts
            };

            if (expectedDimPart == null) {
                currentDimParts = [];
                step.nextTag = currentTag;
                step.nextDimParts = [];
                steps.push(step);
                continue;
            }

            if (enumName) {
                const ternaryExpr = semanticSyntaxCore.parseTopLevelTernaryExpression(actualExpr, {
                    escapeChar: getActiveCtrlChar()
                });
                if (ternaryExpr) {
                    const ternaryResolvedBranch = resolveEnumMemberBranch(actualExpr, enumName);
                    if (ternaryResolvedBranch) {
                        currentTag = ternaryResolvedBranch.nextTag || '';
                        currentDimParts = [...(ternaryResolvedBranch.nextDimParts || [])];
                        step.nextTag = currentTag;
                        step.nextDimParts = [...currentDimParts];
                        steps.push(step);
                        continue;
                    }
                }

                const enumDecl = findLocalDeclByNameFromSources(
                    allDecls,
                    enumName,
                    item => item.type === 'enum',
                    analysisCache
                );
                const memberName = getPawnIdentifierName(actualExpr);
                const memberDecl = enumDecl?.enumMembers?.find(item => item.name === memberName) ||
                    findLocalDeclByNameFromSources(
                        allDecls,
                        memberName,
                        item => item.type === 'enum-item' && normalizeEnumName(item.enumName) === normalizeEnumName(enumName),
                        analysisCache
                    );
                if (!memberDecl) {
                    currentDimParts = currentDimParts.slice(1);
                    step.nextTag = currentTag;
                    step.nextDimParts = [...currentDimParts];
                    if (!canTreatEnumSizedAccessAsScalarIndex(actualExpr, enumName)) {
                        currentDimParts = [];
                        step.nextTag = '';
                        step.nextDimParts = [];
                    }
                    steps.push(step);
                    continue;
                }

                const remainingArrayDims = currentDimParts.slice(1);
                if (remainingArrayDims.length) {
                    currentDimParts = remainingArrayDims;
                } else {
                    currentTag = memberDecl.typeTag || currentTag || '';
                    currentDimParts = getEffectiveDeclDimParts(memberDecl);
                }
                step.nextTag = currentTag;
                step.nextDimParts = [...currentDimParts];
                steps.push(step);
                continue;
            }

            const numericDimensionMemberDecl = !enumName
                ? resolveNumericDimensionEnumField(actualExpr, dimSpec)
                : null;
            if (numericDimensionMemberDecl) {
                const remainingArrayDims = currentDimParts.slice(1);
                if (remainingArrayDims.length) {
                    currentDimParts = remainingArrayDims;
                } else {
                    currentTag = numericDimensionMemberDecl.typeTag || currentTag || '';
                    currentDimParts = getEffectiveDeclDimParts(numericDimensionMemberDecl);
                }
                step.nextTag = currentTag;
                step.nextDimParts = [...currentDimParts];
                steps.push(step);
                continue;
            }

            currentDimParts = currentDimParts.slice(1);
            if (!currentDimParts.length) {
                currentTag = currentTag || getExplicitEnumItemCellTag(actualExpr);
            }
            step.nextTag = currentTag;
            step.nextDimParts = [...currentDimParts];
            steps.push(step);
        }

        return steps;
    }

    const OPERATOR_OVERLOAD_TOKENS = new Set([
        '+', '-', '*', '/', '%', '>', '<', '!', '~', '=',
        '++', '--', '==', '!=', '<=', '>='
    ]);
    const BOOL_RESULT_OPERATOR_TOKENS = new Set(['!', '<', '>', '==', '!=', '<=', '>=']);

    function parseOperatorOverloadToken(name = '') {
        const raw = String(name || '').trim();
        if (!raw.startsWith('operator')) return null;
        const token = raw.slice('operator'.length);
        return token ? token : '';
    }

    function collectOperatorOverloadPolicyIssues(functionDecl, paramTexts = [], analysisCache = null) {
        const token = parseOperatorOverloadToken(functionDecl?.name || '');
        if (token == null) return [];
        const issues = [];

        if (!OPERATOR_OVERLOAD_TOKENS.has(token)) {
            return [{ kind: 'operatorCannotBeRedefined', paramIndex: -1, token }];
        }

        const params = Array.isArray(paramTexts) ? paramTexts : [];
        const metas = params.map(param => analysisCache?.getParamMeta?.(param) || parseParamMeta(param));
        for (let index = 0; index < metas.length; index++) {
            const meta = metas[index] || {};
            const name = meta.name || '';
            if (index < 2 && parseUnionTagOptions(meta.expectedTag || '').length > 1) {
                issues.push({ kind: 'operatorArgumentMayOnlyHaveSingleTag', paramIndex: index, argumentIndex: index + 1 });
            }
            if (token === '~' && index === 0) {
                if (!meta.expectedDims) {
                    issues.push({ kind: 'operatorArgumentMustBeArray', paramIndex: index, name });
                }
            } else if (meta.expectedDims || meta.isByRef) {
                issues.push({ kind: 'operatorArgumentMayNotBeReferenceOrArray', paramIndex: index, name });
            }
        }

        const count = metas.length;
        const expectedCountOk = (() => {
            if (token === '!' || token === '=' || token === '++' || token === '--') return count === 1;
            if (token === '-') return count === 1 || count === 2;
            return count === 2;
        })();
        if (!expectedCountOk) {
            issues.push({ kind: 'operatorOperandCountMismatch', paramIndex: -1, token });
        }

        const tagAt = index => normalizeTagName(metas[index]?.expectedTag || '');
        const firstTag = tagAt(0);
        const secondTag = tagAt(1);
        const resultTag = normalizeTagName(functionDecl?.typeTag || '');
        if (
            !firstTag &&
            (
                (token !== '=' && !secondTag) ||
                (token === '=' && !resultTag)
            )
        ) {
            issues.push({ kind: 'cannotChangePredefinedOperators', paramIndex: -1, token });
        }

        if (BOOL_RESULT_OPERATOR_TOKENS.has(token) && resultTag !== 'bool') {
            issues.push({ kind: 'operatorResultTagMismatch', paramIndex: -1, token, expectedTag: 'bool:' });
        } else if (token === '~' && resultTag && resultTag !== '_') {
            issues.push({ kind: 'operatorResultTagMismatch', paramIndex: -1, token, expectedTag: '_:' });
        }

        return issues;
    }

    function matchPawnTag(expectedTag, actualTag, allowCoerce = true) {
        const expected = normalizeTagName(expectedTag);
        const actual = normalizeTagName(actualTag);
        if (!expected || expected === '_') {
            if (!actual || actual === '_' || isAnyTagName(actual)) return true;
            if (isBoolTagName(actual)) return true;
            return !!allowCoerce && !isFixedPawnTagName(actual);
        }
        if (isBoolTagName(expected) && (!actual || actual === '_')) return true;
        if (isAnyTagName(expected) || isAnyTagName(actual)) return true;
        return expected === actual;
    }

    function resolveTagSpecAlias(tagSpec, decls = [], analysisCache = null, seen = null) {
        const raw = normalizeTagName(tagSpec);
        if (!raw || raw === '_' || raw.startsWith('{') || seen?.has(raw)) return raw;
        const defineDecl = findAnyDeclByNameFromSources(
            decls,
            raw,
            item => item.type === 'define' && !item.args,
            analysisCache
        );
        const value = String(defineDecl?.value || '').trim();
        if (!value) return raw;
        if (value.startsWith('{') && value.endsWith('}')) return value;
        const aliasName = getPawnIdentifierName(value);
        if (!aliasName) return raw;
        const localSeen = seen || new Set();
        localSeen.add(raw);
        const resolved = resolveTagSpecAlias(aliasName, decls, analysisCache, localSeen);
        localSeen.delete(raw);
        return resolved || raw;
    }

    function explainPawnTagCompat(expectedTag, actualTag, decls = [], analysisCache = null) {
        const expected = normalizeTagName(resolveTagSpecAlias(expectedTag, decls, analysisCache));
        const actual = normalizeTagName(actualTag);
        const expectedUnionTags = parseUnionTagOptions(expected);
        if (expectedUnionTags.length) {
            if (expectedUnionTags.some(tag => matchPawnTag(tag, actual, true))) {
                return { status: 'ok', reason: '' };
            }
            if (!actual || actual === '_') {
                return { status: 'warn', reason: t('validation.expectedTag', { tag: expected }) };
            }
            return { status: 'warn', reason: t('validation.tagMismatch', { expected, actual }) };
        }

        if (matchPawnTag(expected, actual, true)) {
            return { status: 'ok', reason: '' };
        }
        if (!expected || expected === '_') {
            return { status: 'warn', reason: t('validation.unexpectedTag', { tag: actual }) };
        }
        if (!actual || actual === '_') {
            return { status: 'warn', reason: t('validation.expectedTag', { tag: expected }) };
        }
        return { status: 'warn', reason: t('validation.tagMismatch', { expected, actual }) };
    }

    function getScalarAssignmentTagIssue(lhsExpr, rhsExpr, decls = [], analysisCache = null, options = {}) {
        const escapeChar = options?.escapeChar ?? getActiveCtrlChar();
        const lhs = String(lhsExpr || '').trim();
        const rhs = String(rhsExpr || '').trim();
        if (!lhs || !rhs || rhs === '_') return null;

        const assignable = options.assignable ||
            getExpressionAssignableInfo(lhs, decls, analysisCache, { escapeChar });
        if (!assignable?.isLValue) return null;

        const rootTagCast = semanticSyntaxCore.getRootTagCastExpression(lhs, { escapeChar });
        const lhsTargetExpr = rootTagCast?.expression || lhs;
        const lhsTargetType = inferArgType(lhsTargetExpr, decls, analysisCache);
        const expectedTargetTag = lhsTargetType?.tag || assignable.baseDecl?.typeTag || '';
        if (rootTagCast && !FORBIDDEN.has(rootTagCast.tag)) {
            const lhsTagResult = explainPawnTagCompat(expectedTargetTag, rootTagCast.tag, decls, analysisCache);
            if (lhsTagResult.status === 'warn' && lhsTagResult.reason) {
                return {
                    status: 'warn',
                    reason: lhsTagResult.reason,
                    expectedTag: expectedTargetTag,
                    actualTag: rootTagCast.tag,
                    rangeTarget: 'lhsTag'
                };
            }
        }

        if (assignable.dims) return null;

        const unresolvedRefs = findUnresolvedReferenceNames(rhs, decls, analysisCache, escapeChar);
        if (unresolvedRefs.length) return null;

        const rhsRootTagCast = getRootTagCastExpressionForValidation(rhs, escapeChar);
        if (rhsRootTagCast?.tag === '_') return null;

        const rhsType = inferArgType(rhs, decls, analysisCache);
        if (rhsType?.dims) return null;

        const expectedTag = expectedTargetTag;
        const actualTag = rhsType?.tag || '';
        const enumMemberTagName = getEnumMemberTagNameForExpression(
            rhs,
            (name, predicate) => findAnyDeclByNameFromSources(decls, name, predicate, analysisCache)
        );
        if (enumMemberTagName) {
            const enumTagResult = explainPawnTagCompat(expectedTag, enumMemberTagName, decls, analysisCache);
            if (enumTagResult.status === 'ok') return null;
        }
        const result = explainPawnTagCompat(expectedTag, actualTag, decls, analysisCache);
        if (result.status !== 'warn' || !result.reason) return null;

        return {
            status: 'warn',
            reason: result.reason,
            expectedTag,
            actualTag,
            rangeTarget: 'rhs'
        };
    }

    function parseWholeCallExpression(expr, escapeChar = getActiveCtrlChar()) {
        const parsed = semanticSyntaxCore.parseWholeCallExpression(expr, { escapeChar });
        if (parsed) return parsed;

        const text = String(expr || '').trim();
        if (!text || text.indexOf('(') < 0) return null;
        const openIndex = text.indexOf('(');
        const closeIndex = findBalancedGroupEnd(text, openIndex, '(', ')', escapeChar);
        if (openIndex <= 0 || closeIndex !== text.length - 1) return null;

        const name = text.slice(0, openIndex).trim();
        if (!/^(?:@?[A-Za-z_][A-Za-z0-9_]*|operator(?:<<=|>>=|==|!=|<=|>=|\+\+|--|&&|\|\||<<|>>|[%*/+\-<>=!&|^~]+))$/.test(name)) {
            return null;
        }

        const argsText = text.slice(openIndex + 1, closeIndex);
        return {
            name,
            openIndex,
            closeIndex,
            argsText,
            args: splitTopLevel(argsText, escapeChar)
        };
    }

    function isIgnoredReferenceName(name) {
        return FORBIDDEN.has(name) ||
            name === '_' ||
            name === 'true' ||
            name === 'false' ||
            name === 'cellmin' ||
            name === 'cellmax' ||
            name === 'char';
    }

    function findUnresolvedReferenceNames(expr, decls = [], analysisCache = null, escapeChar = getActiveCtrlChar()) {
        const cacheKey = String(expr || '').trim();
        if (analysisCache?.unresolvedRefsByExpr.has(cacheKey)) {
            return analysisCache.unresolvedRefsByExpr.get(cacheKey);
        }
        if (!containsPawnIdentifierStartChar(cacheKey)) {
            const result = [];
            if (analysisCache) analysisCache.unresolvedRefsByExpr.set(cacheKey, result);
            return result;
        }

        const source = String(expr || '');
        const hasKnownSymbol = (name, isCallLike) => {
            const predicate = isCallLike
                ? item => isFunctionLikeDecl(item)
                : null;
            if (findAnyDeclByNameFromSources(decls, name, predicate, analysisCache)) return true;
            if (predicate) {
                return !!findObjectAliasTargetDeclByNameFromSources(
                    decls,
                    name,
                    predicate,
                    analysisCache
                );
            }
            return false;
        };
        const findDefineSymbol = name => analysisCache?.findDefineByName
            ? analysisCache.findDefineByName(name)
            : findAnyDeclByNameFromSources(
                decls,
                name,
                item => item.type === 'define',
                analysisCache
            );

        const bareName = getPawnIdentifierName(cacheKey);
        if (bareName && isIgnoredReferenceName(bareName)) {
            const result = [];
            if (analysisCache) analysisCache.unresolvedRefsByExpr.set(cacheKey, result);
            return result;
        }
        if (bareName && !findDefineSymbol(bareName)) {
            const result = hasKnownSymbol(bareName, false)
                ? []
                : [bareName];
            if (analysisCache) analysisCache.unresolvedRefsByExpr.set(cacheKey, result);
            return result;
        }

        const expandedSource = expandExpressionMacrosForTypeInference(source, decls, analysisCache);
        if (expandedSource) {
            const expandedResult = findUnresolvedReferenceNames(expandedSource, decls, analysisCache, escapeChar);
            if (analysisCache) analysisCache.unresolvedRefsByExpr.set(cacheKey, expandedResult);
            return expandedResult;
        }

        const unresolved = new Set();
        let inStr = false;
        let strCh = '';
        const isIdentifierStartAt = usesDefaultPawnIdentifierPredicates
            ? index => isPawnIdentifierStartCode(source.charCodeAt(index))
            : index => isIdentifierStartChar(source[index] || '');
        const isIdentifierContinueAt = usesDefaultPawnIdentifierPredicates
            ? index => isPawnIdentifierContinueCode(source.charCodeAt(index))
            : index => isIdentifierContinueChar(source[index] || '');

        for (let i = 0; i < source.length; i++) {
            const c = source[i];
            if (inStr) {
                if (c === strCh && !isEscapedQuote(source, i, escapeChar)) inStr = false;
                continue;
            }
            if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
                continue;
            }
            if (!isIdentifierStartAt(i)) continue;
            if (isHexLiteralIdentifierTail(source, i)) continue;

            const start = i;
            let end = i + 1;
            while (end < source.length && isIdentifierContinueAt(end)) end++;
            const name = source.slice(i, end);
            i = end - 1;

            if (isIgnoredReferenceName(name)) continue;

            const prevIndex = findPreviousNonWhitespaceIndex(source, start - 1);
            const nextIndex = findFirstNonWhitespaceIndex(source, end);
            const prevChar = prevIndex >= 0 ? source[prevIndex] : '';
            const nextChar = nextIndex >= 0 ? source[nextIndex] : '';

            if (nextChar === ':') continue;
            if (prevChar === '.' && nextChar === '=') continue;

            const isCallLike = nextChar === '(';
            if (!hasKnownSymbol(name, isCallLike)) {
                unresolved.add(name);
            }
        }

        const result = [...unresolved];
        if (analysisCache) analysisCache.unresolvedRefsByExpr.set(cacheKey, result);
        return result;
    }

    const {
        checkParamDeclCompat,
        checkTypeCompat,
        explainParamDeclCompat,
        explainTypeCompat
    } = createTypeCompatCore({
        explainArrayShapeIssue,
        explainPawnTagCompat,
        findLocalDeclByNameFromSources,
        findUnresolvedReferenceNames,
        getActiveCtrlChar,
        getArrayShapeIssue,
        getRootTagCastExpressionForValidation,
        inferArgType,
        inferArrayLikeCallReturnType,
        isImplicitBoolToScalarCompat,
        parseBraceArrayLiteralExpression,
        parseIndexedAccessExpression,
        parseParamMeta,
        parseUnionTagOptions,
        resolveIndexedAccessValidationChain,
        stripTagCastsForValidation,
        t
    });

    return {
        createHoverTypeAnalysisCache,
        inferCallReturnType,
        inferArrayLikeCallReturnType,
        getArrayShapeIssue,
        explainArrayShapeIssue,
        explainArrayShapeDiagnosticIssue,
        inferArgType,
        inferArrayShapeActualType,
        getExpressionAssignableInfo,
        isSyntacticAssignableExpression,
        findArrayMustBeIndexedIssue,
        getScalarAssignmentTagIssue,
        stripTagCastsForValidation,
        unwrapExpressionForValidation,
        stripTrailingSemicolon,
        findFirstNonWhitespaceIndex,
        findPreviousNonWhitespaceIndex,
        findBalancedGroupEnd,
        hasUnclosedFunctionCallGroup,
        isConstVariableDecl,
        isIdentifierStartChar,
        isIdentifierContinueChar,
        isHexLiteralIdentifierTail,
        normalizeEnumName,
        getEnumItemCellSpan,
        inferEffectiveDimPartsFromValue,
        getEffectiveDeclDimParts,
        resolveIndexedAccessValidationChain,
        parseParamMeta,
        parseDimsParts,
        parseWholeCallExpression,
        parseOperatorOverloadToken,
        collectOperatorOverloadPolicyIssues,
        evaluatePawnNumericExpr,
        parseDimSpec,
        isResolvedDimSpec,
        findUnresolvedReferenceNames,
        explainTypeCompat,
        checkTypeCompat,
        explainParamDeclCompat,
        checkParamDeclCompat
    };
}

module.exports = { createValidationCore };
