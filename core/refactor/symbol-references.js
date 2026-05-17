const {
    isPawnIdentifierContinueChar,
    isPawnIdentifierName
} = require('../syntax/identifiers');
const { resolveLineStartOffset } = require('../syntax/lines');

function createSymbolReferenceCore(deps) {
    const {
        vscode,
        getPawnDocumentContext,
        getLookupTokenAtPosition,
        computeFunctionRangeMaps,
        findVariableDeclarationSpanInRange,
        isLinePositionInsideCommentOrString,
        isEscapedQuote,
        isSameFilePath
    } = deps;

    const getDeclPath = decl => String(decl?.filePath || decl?.file || '');

    function isCurrentDocumentDecl(decl, documentPath = '') {
        const declPath = getDeclPath(decl);
        return !declPath || !documentPath || isSameFilePath(declPath, documentPath);
    }

    function getLineStartOffset(document, ctx, lineNumber) {
        return resolveLineStartOffset(
            ctx?.lineStartOffsets || null,
            lineNumber,
            () => document.offsetAt(new vscode.Position(lineNumber, 0))
        );
    }

    function createRange(document, ctx, lineNumber, start, end) {
        const lineStart = getLineStartOffset(document, ctx, lineNumber);
        return new vscode.Range(
            document.positionAt(lineStart + start),
            document.positionAt(lineStart + end)
        );
    }

    function isTokenLiveInSource(ctx, lineNumber, start, end, name) {
        const strippedLine = ctx?.strippedLines?.[lineNumber];
        if (strippedLine == null) return true;
        return String(strippedLine).slice(start, end) === name;
    }

    function buildFunctionLineMaps(ctx) {
        const functions = ctx?.parsedDecls?.functions || [];
        const depths = ctx?.parsedDecls?.depths || [];
        const lineCount = ctx?.rawLines?.length || 0;
        const bodyRanges = computeFunctionRangeMaps(functions, depths, lineCount, { includeHeader: false });
        const fullRanges = computeFunctionRangeMaps(functions, depths, lineCount, { includeHeader: true });
        const functionByHeaderLine = new Map();
        for (const func of functions) {
            const startLine = func?.startLine ?? func?.lineNumber ?? -1;
            const endLine = func?.headerEndLine ?? startLine;
            for (let line = startLine; line <= endLine; line++) {
                if (line >= 0) functionByHeaderLine.set(line, func);
            }
        }
        return { bodyRanges, fullRanges, functionByHeaderLine };
    }

    function getFunctionForDecl(decl, maps) {
        if (!decl) return null;
        const lineNumber = decl.lineNumber ?? -1;
        if (decl.isArg) {
            return maps.functionByHeaderLine.get(lineNumber) || null;
        }
        return maps.bodyRanges.byLine?.[lineNumber]?.func ||
            maps.fullRanges.byLine?.[lineNumber]?.func ||
            null;
    }

    function getEntryScope(decl, functionDecl, maps, lineCount) {
        const functionRange = functionDecl ? maps.fullRanges.byFunction.get(functionDecl) : null;
        if (decl?.isArg) {
            return {
                startLine: functionDecl?.startLine ?? functionDecl?.lineNumber ?? decl.lineNumber ?? 0,
                endLine: functionRange?.endLine ?? Math.max(0, lineCount - 1)
            };
        }
        return {
            startLine: decl?.lineNumber ?? 0,
            endLine: decl?.scopeEndLine ?? functionRange?.endLine ?? Math.max(0, lineCount - 1)
        };
    }

    function buildLocalEntries(ctx, documentPath = '') {
        const maps = buildFunctionLineMaps(ctx);
        const lineCount = ctx?.rawLines?.length || 0;
        const entries = [];
        const pushDecl = decl => {
            if (!decl || decl.type !== 'variable' || !decl.name) return;
            if (!isCurrentDocumentDecl(decl, documentPath)) return;
            const functionDecl = getFunctionForDecl(decl, maps);
            if (!functionDecl) return;
            const scope = getEntryScope(decl, functionDecl, maps, lineCount);
            entries.push({
                decl,
                name: decl.name,
                functionDecl,
                scopeStartLine: Math.max(0, scope.startLine),
                scopeEndLine: Math.max(scope.startLine, scope.endLine),
                declDepth: decl.declDepth ?? 0
            });
        };
        for (const decl of ctx?.parsedDecls?.funcArgs || []) pushDecl(decl);
        for (const decl of ctx?.parsedDecls?.locals || []) pushDecl(decl);
        return { entries, maps };
    }

    function resolveEntryAt(entries, maps, name, lineNumber) {
        const currentFunction = maps.fullRanges.byLine?.[lineNumber]?.func || null;
        let best = null;
        for (const entry of entries) {
            if (entry.name !== name) continue;
            if (currentFunction && entry.functionDecl !== currentFunction) continue;
            if (lineNumber < entry.scopeStartLine || lineNumber > entry.scopeEndLine) continue;
            if (!best) {
                best = entry;
                continue;
            }
            if ((entry.declDepth ?? 0) > (best.declDepth ?? 0)) {
                best = entry;
                continue;
            }
            if (
                (entry.declDepth ?? 0) === (best.declDepth ?? 0) &&
                (entry.decl.lineNumber ?? -1) > (best.decl.lineNumber ?? -1)
            ) {
                best = entry;
            }
        }
        return best;
    }

    function getDeclarationNameRange(document, ctx, decl) {
        if (!decl?.name || !Number.isInteger(decl.lineNumber)) return null;
        const sourceState = {
            rawLines: ctx.rawLines,
            strippedLines: ctx.strippedLines,
            lineCtrlChars: ctx.lineCtrlChars,
            lineStartOffsets: ctx.lineStartOffsets
        };
        const lineStartOffset = getLineStartOffset(document, ctx, decl.lineNumber);
        const lineText = String(ctx.rawLines?.[decl.lineNumber] || '');
        const lineEndOffset = lineStartOffset + lineText.length;
        const span = findVariableDeclarationSpanInRange(
            document,
            lineStartOffset,
            lineEndOffset,
            decl,
            ctx.resolver || null,
            ctx.text || '',
            sourceState,
            decl.name,
            decl.lineNumber,
            decl.lineNumber
        );
        if (span?.startOffset != null) {
            return new vscode.Range(
                document.positionAt(span.startOffset),
                document.positionAt(span.startOffset + decl.name.length)
            );
        }

        const found = lineText.indexOf(decl.name);
        if (found < 0) return null;
        return createRange(document, ctx, decl.lineNumber, found, found + decl.name.length);
    }

    function readNextNonWhitespace(source, start) {
        for (let index = start; index < source.length; index++) {
            if (!/\s/.test(source[index] || '')) return { char: source[index], index };
        }
        return { char: '', index: -1 };
    }

    function isRenameableOccurrence(ctx, lineNumber, source, start, end, name, escapeChar) {
        if (!isTokenLiveInSource(ctx, lineNumber, start, end, name)) return false;
        if (isLinePositionInsideCommentOrString(source, start, escapeChar)) return false;
        const next = readNextNonWhitespace(source, end);
        if (next.char === '(') return false;
        if (next.char === ':') return false;
        return true;
    }

    function collectReferenceRanges(document, ctx, targetEntry, entries, maps) {
        if (!targetEntry?.decl?.name) return [];
        const name = targetEntry.decl.name;
        const ranges = [];
        const seen = new Set();
        const rawLines = ctx.rawLines || [];
        const firstLine = Math.max(0, targetEntry.scopeStartLine);
        const lastLine = Math.min(rawLines.length - 1, targetEntry.scopeEndLine);
        const addRange = (lineNumber, start, end) => {
            const key = `${lineNumber}:${start}:${end}`;
            if (seen.has(key)) return;
            seen.add(key);
            ranges.push(createRange(document, ctx, lineNumber, start, end));
        };

        for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
            const source = String(rawLines[lineNumber] || '');
            const escapeChar = ctx.lineCtrlChars?.[lineNumber] || '';
            for (let index = 0; index < source.length;) {
                const found = source.indexOf(name, index);
                if (found < 0) break;
                const end = found + name.length;
                const before = found > 0 ? source[found - 1] : '';
                const after = end < source.length ? source[end] : '';
                index = end;
                if (
                    (before && isPawnIdentifierContinueChar(before)) ||
                    (after && isPawnIdentifierContinueChar(after))
                ) {
                    continue;
                }
                if (!isRenameableOccurrence(ctx, lineNumber, source, found, end, name, escapeChar)) {
                    continue;
                }
                const resolved = resolveEntryAt(entries, maps, name, lineNumber);
                if (resolved?.decl !== targetEntry.decl) continue;
                addRange(lineNumber, found, end);
            }
        }

        const declarationRange = getDeclarationNameRange(document, ctx, targetEntry.decl);
        if (declarationRange) {
            const startOffset = document.offsetAt(declarationRange.start);
            const endOffset = document.offsetAt(declarationRange.end);
            const start = startOffset - getLineStartOffset(document, ctx, declarationRange.start.line);
            const end = endOffset - getLineStartOffset(document, ctx, declarationRange.end.line);
            addRange(declarationRange.start.line, start, end);
        }

        return ranges.sort((left, right) =>
            document.offsetAt(left.start) - document.offsetAt(right.start)
        );
    }

    function getRenameTarget(document, position) {
        const ctx = getPawnDocumentContext(document, undefined, { preparseLocals: true });
        if (!ctx) return null;
        const token = getLookupTokenAtPosition(document, position, { ctrlCharResolver: ctx.resolver });
        if (!token?.text || token.isOperator) return null;
        const name = String(token.text || '');
        if (!isPawnIdentifierName(name)) return null;
        const lineText = String(ctx.rawLines?.[position.line] ?? document.lineAt(position.line).text ?? '');
        const tokenStart = token.range?.start?.character ?? position.character;
        const tokenEnd = token.range?.end?.character ?? tokenStart + name.length;
        const escapeChar = ctx.lineCtrlChars?.[position.line] || '';
        if (!isRenameableOccurrence(ctx, position.line, lineText, tokenStart, tokenEnd, name, escapeChar)) {
            return null;
        }

        const { entries, maps } = buildLocalEntries(ctx, document.fileName || '');
        const entry = resolveEntryAt(entries, maps, name, position.line);
        if (!entry) return null;
        const ranges = collectReferenceRanges(document, ctx, entry, entries, maps);
        if (!ranges.length) return null;
        return {
            ctx,
            name,
            entry,
            range: token.range,
            references: ranges
        };
    }

    return {
        getRenameTarget,
        isValidRenameName: isPawnIdentifierName
    };
}

module.exports = { createSymbolReferenceCore };
