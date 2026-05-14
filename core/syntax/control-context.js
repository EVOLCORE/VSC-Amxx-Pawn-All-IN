const { isPawnIdentifierContinueChar } = require('./identifiers');
const {
    findNextNonEmptyLine: findNextNonEmptyLineCore,
    isDoWhileClosingLine: isDoWhileClosingLineCore
} = require('./control-lines');

function createControlContextTracker(deps) {
    const {
        strippedLines = [],
        depths = [],
        classifyPawnStatementLine,
        countStructuralBraces,
        findFirstNonWhitespaceIndex,
        findKeywordOccurrences,
        skipInlineControlHeader,
        isDoWhileClosingLine: providedIsDoWhileClosingLine = null
    } = deps;

    const blockContexts = [];
    const singleLineContexts = [];
    let currentLineDepth = 0;

    const findNextNonEmptyLine = startLine =>
        findNextNonEmptyLineCore(strippedLines, startLine, { fallback: startLine });

    const isDoWhileClosingLine = lineNumber => {
        if (typeof providedIsDoWhileClosingLine === 'function') {
            return providedIsDoWhileClosingLine(lineNumber);
        }
        return isDoWhileClosingLineCore(strippedLines, depths, lineNumber);
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

    const beginLine = (lineNumber, currentDepth, trimmedLine = '') => {
        currentLineDepth = currentDepth;
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
    };

    const getActiveContext = () => {
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
        return {
            activeBlockSwitch,
            activeSingleSwitch,
            activeSingleStatementContext,
            activeSwitch,
            hasActiveLoop,
            hasActiveBreakContext: hasActiveLoop || !!activeSwitch,
            inLoop: hasActiveLoop,
            inSwitch: !!activeSwitch,
            inDirectSwitchBody: !!activeBlockSwitch && currentLineDepth === activeBlockSwitch.bodyDepth
        };
    };

    const pushControlContextsFromStatement = (lineNumber, structuralLine, currentDepth, statement, macroProvidedControl = null) => {
        const firstControlStartByType = new Map();
        for (const controlStart of statement?.controlStarts || []) {
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
        if (macroProvidedControl) {
            pushControlContext(
                macroProvidedControl.type,
                lineNumber,
                structuralLine,
                currentDepth,
                macroProvidedControl.start
            );
        }
    };

    const finishLine = (lineNumber, structuralLine) => {
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
    };

    return {
        beginLine,
        getActiveContext,
        pushControlContext,
        pushControlContextsFromStatement,
        finishLine,
        hasInlineContextBefore
    };
}

function computeFallbackLineDepths(lines, countStructuralBraces) {
    const depths = [];
    let depth = 0;
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        depths[lineNumber] = Math.max(0, depth);
        depth = Math.max(0, depth + countStructuralBraces(lines[lineNumber] || ''));
    }
    return depths;
}

function isCompletionIdentifierChar(char) {
    return isPawnIdentifierContinueChar(char || '');
}

function getCompletionTokenStartCharacter(lineText, character) {
    const text = String(lineText || '');
    let index = Math.max(0, Math.min(text.length, Number.isInteger(character) ? character : 0));
    while (index > 0 && isCompletionIdentifierChar(text[index - 1])) index--;
    return index;
}

function countPlainBraceDepth(lineText, startDepth = 0) {
    let depth = Math.max(0, Number.isFinite(startDepth) ? startDepth : 0);
    for (const char of String(lineText || '')) {
        if (char === '{') depth++;
        else if (char === '}') depth = Math.max(0, depth - 1);
    }
    return depth;
}

function getCompletionStructuralLine(document, ctx, lineNumber) {
    return String(ctx?.strippedLines?.[lineNumber] ?? document?.lineAt?.(lineNumber)?.text ?? '');
}

function getCompletionBraceDepthBefore(document, position, ctx) {
    const targetLine = Number.isInteger(position?.line) ? position.line : -1;
    if (targetLine < 0) return 0;
    const targetLineText = getCompletionStructuralLine(document, ctx, targetLine);
    const tokenStart = getCompletionTokenStartCharacter(targetLineText, position?.character);
    const depths = Array.isArray(ctx?.parsedDecls?.depths) ? ctx.parsedDecls.depths : null;

    if (depths && Number.isFinite(depths[targetLine])) {
        return countPlainBraceDepth(targetLineText.slice(0, tokenStart), depths[targetLine]);
    }

    let depth = 0;
    for (let lineNumber = 0; lineNumber < targetLine; lineNumber++) {
        depth = countPlainBraceDepth(getCompletionStructuralLine(document, ctx, lineNumber), depth);
    }
    return countPlainBraceDepth(targetLineText.slice(0, tokenStart), depth);
}

function isTopLevelFunctionDeclarationCompletionPrefix(prefixText) {
    const prefix = String(prefixText || '').trimStart();
    if (!prefix.trim()) return true;
    return /^(?:(?:public|stock|static)\s+)*(?:[A-Za-z_@][A-Za-z0-9_@]*\s*:\s*)?$/i.test(prefix);
}

function isVariableDeclarationCompletionPrefix(prefixText) {
    const prefix = String(prefixText || '').trimStart();
    return /^(?:new|const|static)\b/i.test(prefix);
}

function getCompletionIntent(document, position, ctx) {
    const targetLine = Number.isInteger(position?.line) ? position.line : -1;
    if (targetLine < 0) return 'call';

    const lineText = getCompletionStructuralLine(document, ctx, targetLine);
    const tokenStart = getCompletionTokenStartCharacter(lineText, position?.character);
    const prefixBeforeToken = lineText.slice(0, tokenStart);
    if (isVariableDeclarationCompletionPrefix(prefixBeforeToken)) {
        return 'variable-declaration';
    }
    if (!isTopLevelFunctionDeclarationCompletionPrefix(prefixBeforeToken)) {
        return 'call';
    }

    const depths = Array.isArray(ctx?.parsedDecls?.depths) ? ctx.parsedDecls.depths : null;
    const lineDepth = depths && Number.isFinite(depths[targetLine]) ? depths[targetLine] : null;
    if (lineDepth != null && prefixBeforeToken.indexOf('}') < 0) {
        return lineDepth === 0 ? 'top-level-declaration' : 'call';
    }

    return getCompletionBraceDepthBefore(document, position, ctx) === 0
        ? 'top-level-declaration'
        : 'call';
}

function getCompletionControlContext(options) {
    const {
        document,
        position,
        replaceRange,
        ctx,
        classifyPawnStatementLine,
        countStructuralBraces,
        findFirstNonWhitespaceIndex,
        findKeywordOccurrences,
        skipInlineControlHeader
    } = options;
    if (
        typeof classifyPawnStatementLine !== 'function' ||
        typeof countStructuralBraces !== 'function' ||
        typeof findFirstNonWhitespaceIndex !== 'function' ||
        typeof findKeywordOccurrences !== 'function' ||
        typeof skipInlineControlHeader !== 'function'
    ) {
        return { inLoop: false, inSwitch: false, inDirectSwitchBody: false };
    }

    const targetLine = Number.isInteger(position?.line) ? position.line : -1;
    if (targetLine < 0) return { inLoop: false, inSwitch: false, inDirectSwitchBody: false };
    const targetCharacter = Number.isInteger(replaceRange?.start?.character)
        ? replaceRange.start.character
        : (Number.isInteger(position?.character) ? position.character : 0);

    const lines = [];
    for (let lineNumber = 0; lineNumber <= targetLine; lineNumber++) {
        const line = String(ctx?.strippedLines?.[lineNumber] ?? document?.lineAt?.(lineNumber)?.text ?? '');
        lines[lineNumber] = lineNumber === targetLine
            ? line.slice(0, Math.max(0, targetCharacter))
            : line;
    }
    const depths = Array.isArray(ctx?.parsedDecls?.depths) && ctx.parsedDecls.depths.length
        ? ctx.parsedDecls.depths
        : computeFallbackLineDepths(lines, countStructuralBraces);

    const tracker = createControlContextTracker({
        strippedLines: lines,
        depths,
        classifyPawnStatementLine,
        countStructuralBraces,
        findFirstNonWhitespaceIndex,
        findKeywordOccurrences,
        skipInlineControlHeader
    });

    for (let lineNumber = 0; lineNumber < targetLine; lineNumber++) {
        const structuralLine = lines[lineNumber] || '';
        const trimmedLine = structuralLine.trim();
        const currentDepth = depths[lineNumber] ?? 0;
        tracker.beginLine(lineNumber, currentDepth, trimmedLine);
        if (trimmedLine) {
            const statement = classifyPawnStatementLine(structuralLine);
            tracker.pushControlContextsFromStatement(lineNumber, structuralLine, currentDepth, statement);
        }
        tracker.finishLine(lineNumber, structuralLine);
    }

    const structuralLine = lines[targetLine] || '';
    const trimmedLine = structuralLine.trim();
    const currentDepth = depths[targetLine] ?? 0;
    tracker.beginLine(targetLine, currentDepth, trimmedLine);
    if (trimmedLine) {
        const statement = classifyPawnStatementLine(structuralLine);
        tracker.pushControlContextsFromStatement(targetLine, structuralLine, currentDepth, statement);
    }
    return tracker.getActiveContext();
}

module.exports = {
    createControlContextTracker,
    getCompletionIntent,
    getCompletionControlContext,
    isVariableDeclarationCompletionPrefix
};
