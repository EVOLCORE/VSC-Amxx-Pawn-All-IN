// Shared declaration-span guards used by hover, live validation, and navigation.
// Keeping these in one place avoids subtle drift where one feature treats a
// declaration as "original" while another still tries to validate it.
const {
    createPawnFunctionCallRegex,
    isBareDeclarationKeywordLine,
    isPawnIdentifierContinueCode,
    isWhitespaceCharCode
} = require('./line-utils');
const {
    resolveLineStartOffset,
    splitPawnLines
} = require('../syntax/lines');

function createDeclarationGuardsCore(deps) {
    const {
        vscode,
        escapeRegExp,
        getLookupTokenAtPosition,
        findDefinitionContext,
        collectDeclarationText,
        getCtrlCharStateForContent,
        parseOperatorOverloadToken
    } = deps;
    const variableDeclarationSpanCache = new WeakMap();
    const variableDeclarationLineCoverageCache = new WeakMap();
    const variableDeclarationNameBucketCache = new WeakMap();

    function getCachedVariableDeclarationSpan(document, decl, rawLines, lineCtrlChars, preparedLines = null, lineStartOffsets = null) {
        if (!decl || decl.type !== 'variable') return null;
        let spanCacheByLines = variableDeclarationSpanCache.get(decl);
        if (!spanCacheByLines) {
            spanCacheByLines = new WeakMap();
            variableDeclarationSpanCache.set(decl, spanCacheByLines);
        }
        const sourceKey = preparedLines || rawLines;
        const cached = spanCacheByLines.get(sourceKey);
        if (cached) return cached;

        const { text: declarationText, nextLine } = collectDeclarationText(rawLines, decl.lineNumber, lineCtrlChars, preparedLines);
        const dimsPattern = decl.dims ? `(?:\\s*${escapeRegExp(decl.dims)})?` : '';
        const declPattern = new RegExp(`\\b${escapeRegExp(decl.name)}\\b${dimsPattern}`);
        const getLineStartOffset = lineNumber =>
            resolveLineStartOffset(
                lineStartOffsets,
                lineNumber,
                () => document.offsetAt(new vscode.Position(lineNumber, 0))
            );
        for (let lineNumber = decl.lineNumber; lineNumber < nextLine; lineNumber++) {
            const lineText = rawLines[lineNumber] || '';
            const lineMatch = declPattern.exec(lineText);
            if (!lineMatch) continue;

            const lineStartOffset = getLineStartOffset(lineNumber);
            const span = {
                decl,
                nextLine,
                startOffset: lineStartOffset + lineMatch.index,
                endOffset: lineStartOffset + lineMatch.index + lineMatch[0].length
            };
            spanCacheByLines.set(sourceKey, span);
            return span;
        }

        const declarationStartOffset = getLineStartOffset(decl.lineNumber);
        const match = declPattern.exec(declarationText);
        if (!match) {
            spanCacheByLines.set(sourceKey, null);
            return null;
        }

        const span = {
            decl,
            nextLine,
            startOffset: declarationStartOffset + match.index,
            endOffset: declarationStartOffset + match.index + match[0].length
        };
        spanCacheByLines.set(sourceKey, span);
        return span;
    }

    function getVariableDeclarationCandidatesForLine(document, decls, lineNumber, rawLines, lineCtrlChars, expectedName = '', preparedLines = null) {
        if (!Array.isArray(decls)) {
            return decls ? [decls] : [];
        }
        const targetName = String(expectedName || '');
        if (targetName) {
            let nameBuckets = variableDeclarationNameBucketCache.get(decls);
            if (!nameBuckets) {
                nameBuckets = new Map();
                for (const decl of decls) {
                    if (decl?.type !== 'variable' || !decl.name) continue;
                    let bucket = nameBuckets.get(decl.name);
                    if (!bucket) {
                        bucket = [];
                        nameBuckets.set(decl.name, bucket);
                    }
                    bucket.push(decl);
                }
                variableDeclarationNameBucketCache.set(decls, nameBuckets);
            }
            const namedDecls = nameBuckets.get(targetName) || [];
            if (!namedDecls.length) return [];
            return namedDecls.filter(decl => (decl.lineNumber ?? -1) <= lineNumber);
        }

        let coverageBySource = variableDeclarationLineCoverageCache.get(decls);
        if (!coverageBySource) {
            coverageBySource = new WeakMap();
            variableDeclarationLineCoverageCache.set(decls, coverageBySource);
        }
        const sourceKey = preparedLines || rawLines;
        let coverageByLine = coverageBySource.get(sourceKey);
        if (!coverageByLine) {
            coverageByLine = new Map();
            for (const decl of decls) {
                if (!decl || decl.type !== 'variable') continue;
                const declarationSpan = getCachedVariableDeclarationSpan(document, decl, rawLines, lineCtrlChars, preparedLines);
                if (!declarationSpan) continue;
                for (let coveredLine = decl.lineNumber; coveredLine < declarationSpan.nextLine; coveredLine++) {
                    let coveredDecls = coverageByLine.get(coveredLine);
                    if (!coveredDecls) {
                        coveredDecls = [];
                        coverageByLine.set(coveredLine, coveredDecls);
                    }
                    coveredDecls.push(decl);
                }
            }
            coverageBySource.set(sourceKey, coverageByLine);
        }

        return coverageByLine.get(lineNumber) || [];
    }

    function findFunctionDeclarationNameContext(document, position, functions, ctrlCharResolver = null) {
        const token = getLookupTokenAtPosition(document, position, { ctrlCharResolver });
        if (!token?.text) return null;
        const word = token.text;

        for (const func of functions) {
            const endLine = func.headerEndLine ?? func.startLine;
            if (position.line < func.startLine || position.line > endLine) continue;
            if (func.name !== word) continue;

            const lineText = document.lineAt(position.line).text;
            const isOperatorName = parseOperatorOverloadToken(func.name) !== null;
            const re = isOperatorName
                ? new RegExp(`${escapeRegExp(func.name)}\\s*\\(`)
                : createPawnFunctionCallRegex(func.name, escapeRegExp);
            const match = re.exec(lineText);
            if (!match) continue;

            const nameStart = match.index;
            const nameEnd = nameStart + func.name.length;
            if (position.character < nameStart || position.character > nameEnd) continue;

            return func;
        }

        return null;
    }

    function findHeaderFunctionByNameAtPosition(document, position, functions, ctrlCharResolver = null) {
        const declarationNameCtx = findFunctionDeclarationNameContext(document, position, functions, ctrlCharResolver);
        if (declarationNameCtx) return declarationNameCtx;

        const token = getLookupTokenAtPosition(document, position, { ctrlCharResolver });
        if (!token?.text) return null;
        const word = token.text;

        return functions.find(func => {
            const endLine = func.headerEndLine ?? func.startLine;
            return func.name === word &&
                position.line >= func.startLine &&
                position.line <= endLine;
        }) || null;
    }

    function isOriginalDeclarationHover(document, position, functions, globals, locals, funcArgs, incDecls, ctrlCharResolver = null, lookup = null) {
        const token = getLookupTokenAtPosition(document, position, { ctrlCharResolver });
        const definitionCtx = findDefinitionContext(document, position, functions);
        const word = token?.text || '';

        const headerFuncName = definitionCtx?.funcName;
        const hasIncludeFunctionTwinForName = name => {
            if (!name) return false;
            if (lookup?.hasIncludeFunctionTwin) return lookup.hasIncludeFunctionTwin(name);
            return (incDecls || []).some(d =>
                d.name === name &&
                d.type !== 'variable' &&
                d.type !== 'enum-item' &&
                d.type !== 'define'
            );
        };

        if (!word) {
            return !!definitionCtx && !hasIncludeFunctionTwinForName(headerFuncName);
        }

        if (findFunctionDeclarationNameContext(document, position, functions, ctrlCharResolver)) {
            return !hasIncludeFunctionTwinForName(word);
        }
        if (definitionCtx) {
            const functionNameCtx = findFunctionDeclarationNameContext(document, position, functions, ctrlCharResolver);
            if (!functionNameCtx) return !hasIncludeFunctionTwinForName(headerFuncName);
            return !hasIncludeFunctionTwinForName(word);
        }

        const sameLineDecl = decl => decl.name === word && decl.lineNumber === position.line;
        if (globals.some(sameLineDecl)) return true;
        if (locals.some(sameLineDecl)) return true;
        if (funcArgs.some(sameLineDecl)) return true;

        return false;
    }

    function findVariableDeclarationSpanInRange(document, startOffset, endOffset, variableDecls, ctrlCharResolver = null, sourceText = '', sourceState = null, expectedName = '', knownStartLine = null, knownEndLine = null) {
        const singleDecl = Array.isArray(variableDecls) ? null : (variableDecls || null);
        const decls = singleDecl ? null : (Array.isArray(variableDecls)
            ? variableDecls
            : []);
        const text = String(sourceText || document.getText());
        const lineCtrlChars = sourceState?.lineCtrlChars ||
            ctrlCharResolver?.lineCtrlChars ||
            getCtrlCharStateForContent(text, document.fileName).lineCtrlChars;
        const rawLines = sourceState?.rawLines || splitPawnLines(text);
        const strippedLines = sourceState?.strippedLines || null;
        const lineStartOffsets = sourceState?.lineStartOffsets || null;
        const getLineStartOffset = lineNumber =>
            resolveLineStartOffset(
                lineStartOffsets,
                lineNumber,
                () => document.offsetAt(new vscode.Position(lineNumber, 0))
            );
        const start = Math.max(0, startOffset || 0);
        const end = Math.max(start, endOffset || start);
        const startLine = Number.isInteger(knownStartLine)
            ? knownStartLine
            : document.positionAt(start).line;
        const endLine = Number.isInteger(knownEndLine)
            ? knownEndLine
            : document.positionAt(end).line;
        const candidateDecls = singleDecl
            ? (
                singleDecl.type === 'variable' &&
                (!expectedName || singleDecl.name === expectedName) &&
                (singleDecl.lineNumber ?? -1) <= startLine
                    ? [singleDecl]
                    : []
            )
            : getVariableDeclarationCandidatesForLine(
                document,
                decls,
                startLine,
                rawLines,
                lineCtrlChars,
                expectedName,
                strippedLines
            );

        for (const decl of candidateDecls) {
            if (decl?.type !== 'variable' || decl.lineNumber > endLine) continue;
            if (expectedName && decl.name !== expectedName) continue;

            if (singleDecl && startLine === endLine && startLine === (decl.lineNumber ?? -1)) {
                const lineText = String(rawLines[startLine] || '');
                const name = String(decl.name || '');
                let lineMatchIndex = -1;
                for (let searchIndex = 0; name && searchIndex < lineText.length;) {
                    const foundIndex = lineText.indexOf(name, searchIndex);
                    if (foundIndex < 0) break;
                    const beforeCode = foundIndex > 0 ? lineText.charCodeAt(foundIndex - 1) : 0;
                    const afterIndex = foundIndex + name.length;
                    const afterCode = afterIndex < lineText.length ? lineText.charCodeAt(afterIndex) : 0;
                    if (!isPawnIdentifierContinueCode(beforeCode) && !isPawnIdentifierContinueCode(afterCode)) {
                        lineMatchIndex = foundIndex;
                        break;
                    }
                    searchIndex = foundIndex + name.length;
                }
                if (lineMatchIndex < 0) continue;
                const lineStartOffset = getLineStartOffset(startLine);
                const spanStart = lineStartOffset + lineMatchIndex;
                let spanEnd = spanStart + name.length;
                const dims = String(decl.dims || '');
                if (dims) {
                    let dimsStart = lineMatchIndex + name.length;
                    while (dimsStart < lineText.length && isWhitespaceCharCode(lineText.charCodeAt(dimsStart))) dimsStart++;
                    if (lineText.startsWith(dims, dimsStart)) {
                        spanEnd = lineStartOffset + dimsStart + dims.length;
                    }
                }
                if (start >= spanStart && end <= spanEnd) {
                    return {
                        decl,
                        startOffset: spanStart,
                        endOffset: spanEnd
                    };
                }
                continue;
            }

            if (startLine > decl.lineNumber) {
                const declarationLine = String((strippedLines?.[decl.lineNumber] ?? rawLines[decl.lineNumber]) || '');
                const initialTrimmed = declarationLine.trimEnd();
                if (
                    declarationLine.indexOf('(') < 0 &&
                    declarationLine.indexOf(')') < 0 &&
                    !initialTrimmed.endsWith(',') &&
                    !/=\s*$/.test(initialTrimmed) &&
                    !isBareDeclarationKeywordLine(initialTrimmed) &&
                    declarationLine.indexOf('\\') < 0
                ) {
                    continue;
                }
            }

            const declarationSpan = getCachedVariableDeclarationSpan(document, decl, rawLines, lineCtrlChars, strippedLines, lineStartOffsets);
            if (!declarationSpan) continue;
            if (startLine < decl.lineNumber || endLine >= declarationSpan.nextLine) continue;

            if (start >= declarationSpan.startOffset && end <= declarationSpan.endOffset) {
                return {
                    decl,
                    startOffset: declarationSpan.startOffset,
                    endOffset: declarationSpan.endOffset
                };
            }
        }

        return null;
    }

    function shouldSuppressVariableDeclarationValidationInRange(document, startOffset, endOffset, ctx, variableDecls, sourceState = null, expectedName = '', knownStartLine = null, knownEndLine = null) {
        return !!findVariableDeclarationSpanInRange(
            document,
            startOffset,
            endOffset,
            variableDecls,
            ctx?.resolver || null,
            ctx?.text || '',
            sourceState,
            expectedName,
            knownStartLine,
            knownEndLine
        );
    }

    return {
        findFunctionDeclarationNameContext,
        findHeaderFunctionByNameAtPosition,
        isOriginalDeclarationHover,
        findVariableDeclarationSpanInRange,
        shouldSuppressVariableDeclarationValidationInRange
    };
}

module.exports = { createDeclarationGuardsCore };
