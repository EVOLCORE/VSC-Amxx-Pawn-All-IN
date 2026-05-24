const { createLineMembership } = require('../../core/utils/line-membership');
const { normalizePathKey } = require('../../core/utils/path');
const { getEffectiveIncludeFileExtensions } = require('../../core/include-extensions');
const { createIncludeValidationPolicy } = require('../../core/include-validation-policy');
const { getPawnIdentifierName } = require('../../core/syntax/identifiers');
const { splitPawnLines } = require('../../core/syntax/lines');
const { hasTrailingBackslashContinuation } = require('../../core/syntax/continuation');

const EMPTY_DECLS_FOR_LINE = [];
const EMPTY_VARIABLE_DECLS_FOR_LINE = {
    currentArgs: EMPTY_DECLS_FOR_LINE,
    currentLocals: EMPTY_DECLS_FOR_LINE,
    currentGlobals: EMPTY_DECLS_FOR_LINE
};

function findSameLineVariableDecl(decls, name, lineNumber, filePath) {
    for (const decl of decls || EMPTY_DECLS_FOR_LINE) {
        if (
            decl?.type === 'variable' &&
            decl.name === name &&
            decl.lineNumber === lineNumber &&
            (!decl.filePath || !filePath || decl.filePath === filePath)
        ) {
            return decl;
        }
    }
    return null;
}

function createSharedContextDiagnostics(deps) {
    const {
        settingsService,
        areLiveValidationWarningsEnabled,
        computeFunctionRangeMaps,
        getPreferredFunctionHoverMatch,
        hasIncludeFunctionTwin,
        isFunctionLikeDecl,
        isFunctionLikeDefineDecl,
        isEscapedQuote,
        isOperatorOverloadName
    } = deps;

    const includeValidationPolicy = createIncludeValidationPolicy({
        getIncludeFileExtensions: () => {
            const extensions = settingsService?.getIncludeFileExtensions?.();
            return Array.isArray(extensions) && extensions.length
                ? extensions
                : getEffectiveIncludeFileExtensions();
        },
        getIncludeValidationMode: () => settingsService?.getIncludeValidationMode?.() || 'balanced'
    });
    const getIncludeValidationMode = includeValidationPolicy.getIncludeValidationMode;
    const isStrictIncludeValidationEnabled = includeValidationPolicy.isStrictIncludeValidationEnabled;
    const getCallbackSignatureMode = () => settingsService?.getCallbackSignatureMode?.() || 'strict';
    const areWarningDiagnosticsEnabled = () =>
        areLiveValidationWarningsEnabled(settingsService?.getLiveValidationIssueMode?.());
    const shouldIncludeTargetLine = (targetLines, lineNumber) => !targetLines || targetLines.has(lineNumber);
    const functionHeaderNameSetsByFunctions = new WeakMap();
    const isFunctionDefinitionHeaderCall = (ctx, funcName, lineNumber) => {
        const parsedDecls = ctx?.parsedDecls || null;
        if (!parsedDecls || !funcName || !Number.isInteger(lineNumber)) return false;
        const functions = parsedDecls.functions || [];
        let headerNamesByLine = functionHeaderNameSetsByFunctions.get(functions);
        if (!headerNamesByLine) {
            headerNamesByLine = new Map();
            for (const func of functions) {
                if (!func?.name) continue;
                const startLine = func.startLine ?? func.lineNumber ?? -1;
                const endLine = func.headerEndLine ?? startLine;
                for (let line = startLine; line <= endLine; line++) {
                    if (line < 0) continue;
                    let names = headerNamesByLine.get(line);
                    if (!names) {
                        names = new Set();
                        headerNamesByLine.set(line, names);
                    }
                    names.add(func.name);
                }
            }
            functionHeaderNameSetsByFunctions.set(functions, headerNamesByLine);
        }
        return !!headerNamesByLine.get(lineNumber)?.has(funcName);
    };
    const isFunctionLikeLookupDecl = decl => isFunctionLikeDecl(decl);
    const isObjectAliasDefineLookupDecl = decl => decl?.type === 'define' && !decl.args && !decl.macroStyle;
    const hasIncludeFunctionTwinWithAtFallback = (name, incDecls, lookup) => {
        if (hasIncludeFunctionTwin(name, incDecls, lookup)) return true;
        const text = String(name || '');
        if (!text.startsWith('@') || text.length <= 1) return false;
        return hasIncludeFunctionTwin(text.slice(1), incDecls, lookup);
    };
    const callSignatureDataCacheByAnalysis = new WeakMap();
    const directCallSignatureDataCacheByFunctionList = new WeakMap();
    const functionHeaderLinesByParsedDecls = new WeakMap();
    const functionHeaderLinesByFunctionList = new WeakMap();
    const enumMemberLinesByParsedDecls = new WeakMap();
    const functionRangeMapsByParsedDecls = new WeakMap();
    const variableDeclsByLineIndexByParsedDecls = new WeakMap();
    const documentVariableDeclCacheByLookup = new WeakMap();
    const headerCandidateMetaByParsedDecls = new WeakMap();
    const lineStringLiteralStateByParsedDecls = new WeakMap();
    const lineStringLiteralStateByRawLines = new WeakMap();
    const normalizedDocumentPathCache = new WeakMap();
    const normalizedDeclPathCache = new WeakMap();


    const isIncludeDocument = includeValidationPolicy.isIncludeDocument;



    function getDirectCallSignatureData(callName, ctx) {
        const functions = ctx?.parsedDecls?.functions || null;
        if (!callName || !Array.isArray(functions)) return null;
        const includeDecls = Array.isArray(ctx.incDecls) ? ctx.incDecls : [];
        let byIncludeList = directCallSignatureDataCacheByFunctionList.get(functions);
        if (!byIncludeList) {
            byIncludeList = new WeakMap();
            directCallSignatureDataCacheByFunctionList.set(functions, byIncludeList);
        }
        let byName = byIncludeList.get(includeDecls);
        if (!byName) {
            byName = new Map();
            byIncludeList.set(includeDecls, byName);
        }
        if (byName.has(callName)) {
            return byName.get(callName);
        }
        const signatureData = getPreferredFunctionHoverMatch(
            callName,
            functions,
            ctx.incDecls,
            { preferInclude: hasIncludeFunctionTwin(callName, ctx.incDecls, ctx.lookup) },
            ctx.lookup
        )?.data || null;
        byName.set(callName, signatureData || null);
        return signatureData || null;
    }



    function getResolvedCallSignatureData(callName, ctx, analysisCache) {
        if (!callName) return null;

        let cache = callSignatureDataCacheByAnalysis.get(analysisCache);
        if (!cache) {
            cache = new Map();
            callSignatureDataCacheByAnalysis.set(analysisCache, cache);
        }
        if (cache.has(callName)) {
            return cache.get(callName);
        }

        let signatureData = getDirectCallSignatureData(callName, ctx);
        if (!signatureData) {
            const aliasDefine = ctx.lookup.findAnyDeclByName(
                callName,
                item => item.type === 'define' && !item.args && !item.macroStyle
            );
            const aliasTargetName = getPawnIdentifierName(aliasDefine?.value);
            if (aliasTargetName) {
                signatureData = getDirectCallSignatureData(aliasTargetName, ctx);
            }
        }

        cache.set(callName, signatureData || null);
        return signatureData || null;
    }



    function findDocumentVariableDeclByName(ctx, name, lineNumber = -1, options = {}) {
        if (!name || !ctx?.lookup) return null;
        const sameLineOnly = options.sameLineOnly === true;
        const lookupKey = ctx.lookup;
        const fpKey = ctx.fp || '';
        const cacheKey = `${sameLineOnly ? '1' : '0'}:${Number.isInteger(lineNumber) ? lineNumber : -1}:${name}`;
        let cacheByFile = documentVariableDeclCacheByLookup.get(lookupKey);
        if (!cacheByFile) {
            cacheByFile = new Map();
            documentVariableDeclCacheByLookup.set(lookupKey, cacheByFile);
        }
        let cacheByName = cacheByFile.get(fpKey);
        if (!cacheByName) {
            cacheByName = new Map();
            cacheByFile.set(fpKey, cacheByName);
        }
        if (cacheByName.has(cacheKey)) {
            return cacheByName.get(cacheKey);
        }
        if (Number.isInteger(lineNumber) && lineNumber >= 0) {
            const {
                currentArgs,
                currentLocals,
                currentGlobals
            } = getVariableDeclsForLine(ctx, lineNumber);
            const sameLineDecl =
                findSameLineVariableDecl(currentArgs, name, lineNumber, ctx.fp) ||
                findSameLineVariableDecl(currentLocals, name, lineNumber, ctx.fp) ||
                findSameLineVariableDecl(currentGlobals, name, lineNumber, ctx.fp);
            if (sameLineDecl) {
                cacheByName.set(cacheKey, sameLineDecl);
                return sameLineDecl;
            }
        }
        if (sameLineOnly) {
            cacheByName.set(cacheKey, null);
            return null;
        }
        const decl = ctx.lookup.findDocumentVariable?.(name) ||
            ctx.lookup.findFuncArg(name) ||
            ctx.lookup.findLocal(name) ||
            ctx.lookup.findGlobal(name) ||
            null;
        const result = decl?.type === 'variable'
            ? decl
            : (
                ctx.lookup.findAnyLocalDeclByName(
                    name,
                    item => item?.type === 'variable' && (!item.filePath || item.filePath === ctx.fp)
                ) || null
            );
        cacheByName.set(cacheKey, result);
        return result;
    }



    function getVariableDeclsByLineIndex(parsedDecls) {
        let index = variableDeclsByLineIndexByParsedDecls.get(parsedDecls);
        if (index) return index;

        const argsByLine = new Map();
        const localsByLine = new Map();
        const globalsByLine = new Map();
        const addDecl = (map, decl) => {
            if (decl?.type !== 'variable' || !Number.isInteger(decl.lineNumber)) return;
            let bucket = map.get(decl.lineNumber);
            if (!bucket) {
                bucket = [];
                map.set(decl.lineNumber, bucket);
            }
            bucket.push(decl);
        };
        for (const decl of parsedDecls.funcArgs || []) addDecl(argsByLine, decl);
        for (const decl of parsedDecls.locals || []) addDecl(localsByLine, decl);
        for (const decl of parsedDecls.globals || []) addDecl(globalsByLine, decl);

        index = {
            argsByLine,
            localsByLine,
            globalsByLine,
            declsByLine: new Map()
        };
        variableDeclsByLineIndexByParsedDecls.set(parsedDecls, index);
        return index;
    }



    function getVariableDeclsForLine(ctx, lineNumber) {
        const parsedDecls = ctx?.parsedDecls || null;
        if (!parsedDecls) {
            return EMPTY_VARIABLE_DECLS_FOR_LINE;
        }
        const index = getVariableDeclsByLineIndex(parsedDecls);
        if (index.declsByLine.has(lineNumber)) {
            return index.declsByLine.get(lineNumber);
        }

        const currentArgs = index.argsByLine.get(lineNumber) || EMPTY_DECLS_FOR_LINE;
        const currentLocals = index.localsByLine.get(lineNumber) || EMPTY_DECLS_FOR_LINE;
        const currentGlobals = (parsedDecls.depths?.[lineNumber] ?? 0) === 0
            ? (index.globalsByLine.get(lineNumber) || EMPTY_DECLS_FOR_LINE)
            : EMPTY_DECLS_FOR_LINE;
        const lineDecls = (
            currentArgs.length ||
            currentLocals.length ||
            currentGlobals.length
        )
            ? { currentArgs, currentLocals, currentGlobals }
            : null;
        if (!lineDecls) {
            return EMPTY_VARIABLE_DECLS_FOR_LINE;
        }
        index.declsByLine.set(lineNumber, lineDecls);
        return lineDecls;
    }

    function getLineStringLiteralState(ctx) {
        const parsedDecls = ctx?.parsedDecls || null;
        const rawLines = ctx.rawLines || splitPawnLines(ctx.text);
        if (rawLines && lineStringLiteralStateByRawLines.has(rawLines)) {
            return lineStringLiteralStateByRawLines.get(rawLines);
        }
        if (parsedDecls && lineStringLiteralStateByParsedDecls.has(parsedDecls)) {
            return lineStringLiteralStateByParsedDecls.get(parsedDecls);
        }

        const lineCtrlChars = ctx.lineCtrlChars || [];
        const flags = new Uint8Array(rawLines.length);
        const startQuoteCodes = new Uint16Array(rawLines.length);
        let openStringQuote = '';
        let continuedStringQuote = '';
        let blockComment = false;

        for (let lineNumber = 0; lineNumber < rawLines.length; lineNumber++) {
            const lineText = String(rawLines[lineNumber] || '');
            const escapeChar = lineCtrlChars[lineNumber] || ctx.resolver?.ctrlCharAtLine?.(lineNumber);
            let inStr = !!openStringQuote;
            let strCh = openStringQuote;
            if (continuedStringQuote) {
                startQuoteCodes[lineNumber] = continuedStringQuote.charCodeAt(0);
            }
            if (inStr) flags[lineNumber] = 1;
            if (
                !inStr &&
                !blockComment &&
                lineText.indexOf('"') < 0 &&
                lineText.indexOf('\'') < 0 &&
                lineText.indexOf('/') < 0
            ) {
                continue;
            }
            let lineComment = false;

            for (let index = 0; index < lineText.length; index++) {
                const char = lineText[index];
                if (blockComment) {
                    if (char === '*' && lineText[index + 1] === '/') {
                        blockComment = false;
                        index++;
                    }
                    continue;
                }
                if (lineComment) break;
                if (inStr) {
                    if (char === strCh && !isEscapedQuote(lineText, index, escapeChar)) {
                        inStr = false;
                    }
                    continue;
                }
                if (char === '/' && lineText[index + 1] === '/') {
                    lineComment = true;
                    continue;
                }
                if (char === '/' && lineText[index + 1] === '*') {
                    blockComment = true;
                    index++;
                    continue;
                }
                if (char === '"' || char === '\'') {
                    inStr = true;
                    strCh = char;
                    flags[lineNumber] = 1;
                }
            }
            openStringQuote = inStr ? strCh : '';
            continuedStringQuote = inStr && strCh && hasTrailingBackslashContinuation(lineText)
                ? strCh
                : '';
        }

        const state = {
            flags,
            startQuoteCodes
        };
        if (rawLines) {
            lineStringLiteralStateByRawLines.set(rawLines, state);
        }
        if (parsedDecls) {
            lineStringLiteralStateByParsedDecls.set(parsedDecls, state);
        }
        return state;
    }



    function getMultilineStringLineFlags(ctx) {
        return getLineStringLiteralState(ctx).flags;
    }



    function getLineStringStartQuoteCodes(ctx) {
        return getLineStringLiteralState(ctx).startQuoteCodes;
    }



    function getFunctionHeaderLines(ctx) {
        const parsedDecls = ctx?.parsedDecls || null;
        if (!parsedDecls) return createLineMembership(0);
        const functions = parsedDecls.functions || [];
        let headerLines = Array.isArray(functions)
            ? functionHeaderLinesByFunctionList.get(functions)
            : null;
        if (!headerLines) {
            headerLines = functionHeaderLinesByParsedDecls.get(parsedDecls);
        }
        if (!headerLines) {
            let lineCount = (ctx?.rawLines || []).length;
            if (!lineCount) {
                for (const func of functions) {
                    const endLine = func.headerEndLine ?? func.startLine;
                    if (Number.isInteger(endLine) && endLine >= lineCount) {
                        lineCount = endLine + 1;
                    }
                }
            }
            headerLines = createLineMembership(lineCount);
            for (const func of functions) {
                const endLine = func.headerEndLine ?? func.startLine;
                for (let line = func.startLine; line <= endLine; line++) {
                    headerLines.add(line);
                }
            }
            if (Array.isArray(functions)) {
                functionHeaderLinesByFunctionList.set(functions, headerLines);
            }
            functionHeaderLinesByParsedDecls.set(parsedDecls, headerLines);
        }
        return headerLines;
    }



    function isFunctionHeaderLine(ctx, lineNumber) {
        const headerLines = getFunctionHeaderLines(ctx);
        return headerLines.has(lineNumber);
    }



    function getEnumMemberDeclarationLines(ctx) {
        const parsedDecls = ctx?.parsedDecls || null;
        if (!parsedDecls) return createLineMembership(0);
        let enumMemberLines = enumMemberLinesByParsedDecls.get(parsedDecls);
        if (!enumMemberLines) {
            enumMemberLines = createLineMembership((ctx?.rawLines || []).length);
            const addEnumMemberLines = decls => {
                for (const decl of decls || []) {
                    if (decl?.type !== 'enum-item') continue;
                    const declLine = decl.lineNumber ?? -1;
                    if (declLine >= 0) {
                        enumMemberLines.add(declLine);
                    }
                }
            };
            addEnumMemberLines(parsedDecls.globals);
            addEnumMemberLines(parsedDecls.locals);
            enumMemberLinesByParsedDecls.set(parsedDecls, enumMemberLines);
        }
        return enumMemberLines;
    }



    function isEnumMemberDeclarationLine(ctx, lineNumber) {
        const enumMemberLines = getEnumMemberDeclarationLines(ctx);
        return enumMemberLines.has(lineNumber);
    }



    function getFunctionRangeMaps(ctx) {
        const parsedDecls = ctx?.parsedDecls || null;
        if (!parsedDecls) {
            return {
                byLine: [],
                byFunction: new WeakMap()
            };
        }
        if (functionRangeMapsByParsedDecls.has(parsedDecls)) {
            return functionRangeMapsByParsedDecls.get(parsedDecls);
        }
        const rangeMaps = computeFunctionRangeMaps(
            parsedDecls.functions || [],
            parsedDecls.depths || [],
            (ctx?.rawLines || []).length
        );
        functionRangeMapsByParsedDecls.set(parsedDecls, rangeMaps);
        return rangeMaps;
    }



    function getFunctionBodyRangeByLine(ctx) {
        return getFunctionRangeMaps(ctx).byLine || [];
    }



    function getHeaderCandidateMeta(ctx) {
        const parsedDecls = ctx?.parsedDecls || null;
        if (!parsedDecls) {
            return {
                functions: [],
                byLine: new Map()
            };
        }
        if (headerCandidateMetaByParsedDecls.has(parsedDecls)) {
            return headerCandidateMetaByParsedDecls.get(parsedDecls);
        }

        const functionsByName = new Map();
        for (const func of parsedDecls.functions || []) {
            if (!func?.name) continue;
            let group = functionsByName.get(func.name);
            if (!group) {
                group = [];
                functionsByName.set(func.name, group);
            }
            group.push(func);
        }

        const candidateFunctions = [];
        const byLine = new Map();
        for (const func of parsedDecls.functions || []) {
            const sameNameDecls = functionsByName.get(func.name) || [];
            const isMainEntryWithArgs = (func.name === 'main' || func.name === 'entry') &&
                !!String(func.args || '').trim();
            const hasDefaultParamDiagnostics = String(func.args || '').includes('=');
            const hasOperatorHeaderDiagnostics = isOperatorOverloadName(func.name);
            const hasStateHeaderDiagnostics = !!func.stateSpec;
            const isCandidate = isMainEntryWithArgs ||
                hasDefaultParamDiagnostics ||
                hasOperatorHeaderDiagnostics ||
                hasStateHeaderDiagnostics ||
                hasIncludeFunctionTwinWithAtFallback(func.name, ctx.incDecls, ctx.lookup) ||
                sameNameDecls.length > 1;
            if (!isCandidate) continue;
            candidateFunctions.push(func);
            const endLine = func.headerEndLine ?? func.startLine;
            for (let line = func.startLine; line <= endLine; line++) {
                let lineFuncs = byLine.get(line);
                if (!lineFuncs) {
                    lineFuncs = [];
                    byLine.set(line, lineFuncs);
                }
                lineFuncs.push(func);
            }
        }

        const meta = { functions: candidateFunctions, byLine };
        headerCandidateMetaByParsedDecls.set(parsedDecls, meta);
        return meta;
    }



    function getNormalizedDocumentPath(document) {
        if (!document || typeof document !== 'object') {
            return normalizePathKey(document?.fileName || '');
        }
        const fileName = String(document.fileName || '');
        const cached = normalizedDocumentPathCache.get(document);
        if (cached?.fileName === fileName) return cached.path;
        const normalized = normalizePathKey(fileName);
        normalizedDocumentPathCache.set(document, { fileName, path: normalized });
        return normalized;
    }



    function getNormalizedDeclPath(decl) {
        if (!decl || typeof decl !== 'object') return '';
        const rawPath = String(decl.filePath || decl.file || '');
        const cached = normalizedDeclPathCache.get(decl);
        if (cached?.rawPath === rawPath) return cached.path;
        const normalized = normalizePathKey(rawPath);
        normalizedDeclPathCache.set(decl, { rawPath, path: normalized });
        return normalized;
    }

    return {
        getIncludeValidationMode,
        isStrictIncludeValidationEnabled,
        getCallbackSignatureMode,
        areWarningDiagnosticsEnabled,
        shouldIncludeTargetLine,
        isFunctionDefinitionHeaderCall,
        isFunctionLikeLookupDecl,
        isObjectAliasDefineLookupDecl,
        isIncludeDocument,
        getResolvedCallSignatureData,
        findDocumentVariableDeclByName,
        getVariableDeclsForLine,
        getMultilineStringLineFlags,
        getLineStringStartQuoteCodes,
        getFunctionHeaderLines,
        isFunctionHeaderLine,
        getEnumMemberDeclarationLines,
        isEnumMemberDeclarationLine,
        getFunctionRangeMaps,
        getFunctionBodyRangeByLine,
        getHeaderCandidateMeta,
        getNormalizedDocumentPath,
        getNormalizedDeclPath
    };
}

module.exports = { createSharedContextDiagnostics };
