// Hover-specific helpers that are shared by the normal hover builder and
// persistent-hover orchestration live with the hover feature, not in
// persistent-hover itself. Persistent hover only decides when to open the
// widget; these helpers decide whether a hover target is meaningful.
const { splitPawnLines } = require('../../core/syntax/lines');

function createHoverHelpersFeature(deps) {
    const {
        vscode,
        getWordAtPosition,
        computeLineDepths,
        findPreferredKnownCallContext,
        findNestedParentCallNameContext,
        findFunctionDeclarationNameContext,
        findDefinitionContext,
        hasIncludeFunctionTwin,
        isKnownFunctionName,
        isNearbyCallContext,
        isMeaningfulCallCursorPosition,
        findIndexedAccessContextAtPosition,
        resolveDefaultAccessSymbolName,
        getActiveCtrlChar,
        stripLineComment,
        hasBitmaskOperator,
        extractAssignmentBitmaskRhsInfo,
        getBitmaskExpressionCandidates,
        splitTopLevelBitmaskTermsWithOffsets,
        evaluatePawnNumericExpr,
        FORBIDDEN
    } = deps;

    function isHoverAtActiveCursor(document, position) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return false;
        if (editor.document.uri.toString() !== document.uri.toString()) return false;
        return editor.selection.isEmpty && editor.selection.active.isEqual(position);
    }

    function findHoveredBitmaskPart(document, position, allDecls, ctrlCharResolver = null) {
        const lineText = stripLineComment(
            document.lineAt(position.line).text,
            ctrlCharResolver?.ctrlCharAtLine(position.line) || getActiveCtrlChar()
        );
        const cursorColumn = Math.min(position.character, lineText.length);
        const candidates = getBitmaskExpressionCandidates(lineText, cursorColumn);
        for (const candidate of candidates) {
            const rhsInfo = extractAssignmentBitmaskRhsInfo(candidate.rawExpr);
            const expr = rhsInfo.expr;
            if (!expr || !hasBitmaskOperator(expr)) continue;

            const cursorInRawExpr = Math.max(0, cursorColumn - candidate.start - candidate.leadingTrim);
            const cursorInExpr = Math.max(0, cursorInRawExpr - rhsInfo.rhsStart);
            const terms = splitTopLevelBitmaskTermsWithOffsets(expr);
            const hoveredTerm = terms.find(term => cursorInExpr >= term.start && cursorInExpr <= term.end);
            if (!hoveredTerm?.text) continue;

            const value = evaluatePawnNumericExpr(hoveredTerm.text, allDecls);
            if (value == null) continue;

            return {
                expr: hoveredTerm.text,
                value
            };
        }

        return null;
    }

    function findHoveredIndexedAccessContext(document, position, ctrlCharResolver = null) {
        const context = findIndexedAccessContextAtPosition(document, position, ctrlCharResolver);
        return context?.activeAccessIndex != null ? context : null;
    }

    function applyHoverDisplayNameSuffixToMatches(matches, word, wordAccessSuffix) {
        if (!wordAccessSuffix) return;
        for (const match of matches) {
            if (
                match.data?.type === 'variable' &&
                match.data.name === word &&
                !match.data.hoverDisplayName
            ) {
                match.data = {
                    ...match.data,
                    hoverDisplayName: `${match.data.name}${wordAccessSuffix}`
                };
            }
        }
    }

    function resolveArgumentSymbolName(hoveredWord, argExpr, funcName) {
        if (hoveredWord && hoveredWord !== funcName) {
            const trimmedExpr = (argExpr || '').trim();
            const tagCast = trimmedExpr.match(/^([A-Za-z_@]\w*)\s*:\s*(.+)$/);
            if (!tagCast || tagCast[1] !== hoveredWord) return hoveredWord;
        }
        return resolveDefaultAccessSymbolName(argExpr, { forbiddenTags: FORBIDDEN }) || null;
    }

    function resolvePersistentHoverTarget(document, position, functions, incDecls, cursorDepth = null, lookup = null) {
        const depth = cursorDepth ?? (() => {
            const rawLines = splitPawnLines(document.getText());
            const depths = computeLineDepths(rawLines);
            return position.line < depths.length ? depths[position.line] : 0;
        })();
        const word = getWordAtPosition(document, position);
        const parentCallCtx = findPreferredKnownCallContext(document, position, functions, incDecls, lookup);
        const nestedCallNameInfo = findNestedParentCallNameContext(document, position, functions, incDecls, lookup);
        const callNameCtx = nestedCallNameInfo.callNameCtx;
        const nestedParentCallCtx = nestedCallNameInfo.parentCallCtx;
        const nestedFunctionArgCtx =
            callNameCtx && nestedParentCallCtx && word === callNameCtx.funcName
                ? { parent: nestedParentCallCtx, child: callNameCtx }
                : null;
        const declarationNameCtx = findFunctionDeclarationNameContext(document, position, functions);
        const definitionCtx = findDefinitionContext(document, position, functions);
        if (declarationNameCtx) {
            return hasIncludeFunctionTwin(declarationNameCtx.name, incDecls, lookup)
                ? declarationNameCtx.name
                : null;
        }

        if (definitionCtx) {
            return hasIncludeFunctionTwin(definitionCtx.funcName, incDecls, lookup)
                ? definitionCtx.funcName
                : null;
        }

        if (nestedFunctionArgCtx) {
            return nestedFunctionArgCtx.parent.funcName;
        }

        if (word && isKnownFunctionName(word, functions, incDecls, lookup)) {
            return word;
        }

        const rawCallCtx = parentCallCtx;
        const callCtx = isNearbyCallContext(document, position, rawCallCtx) ? rawCallCtx : null;
        if (depth > 0 && isMeaningfulCallCursorPosition(document, position, callCtx)) {
            return callCtx.funcName;
        }

        return null;
    }

    return {
        isHoverAtActiveCursor,
        findHoveredBitmaskPart,
        findHoveredIndexedAccessContext,
        applyHoverDisplayNameSuffixToMatches,
        resolvePersistentHoverTarget,
        resolveArgumentSymbolName
    };
}

module.exports = { createHoverHelpersFeature };
