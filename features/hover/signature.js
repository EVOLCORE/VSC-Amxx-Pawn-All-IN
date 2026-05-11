// Signature highlighting/render helpers are hover-specific presentation logic.
// They belong with the hover feature rather than with generic validation/core
// code, even though they reuse shared type-compatibility analysis.
const { findBalancedGroupEnd } = require('../../core/syntax/balanced');
const { isPawnIdentifierBoundaryChar } = require('../../core/syntax/identifiers');

function createHoverSignatureFeature(deps) {
    const {
        t,
        buildSig,
        splitTopLevel,
        buildCallArgLayout,
        collectCallArgumentIssues,
        createHoverTypeAnalysisCache,
        resolveIndexedAccessValidationChain,
        parseIndexedAccessExpression,
        parseDimsParts,
        explainIndexedAccessDimCompat,
        isFunctionLikeDefineDecl
    } = deps;

    const SIG_ERROR_OPEN = '\u200B';
    const SIG_ERROR_CLOSE = '\u200C';
    const SIG_ACTIVE_OPEN = '\u200D';
    const SIG_ACTIVE_CLOSE = '\u2060';
    const SIGNATURE_WRAP_WIDTH = 80;
    const SIGNATURE_CONTINUATION_INDENT = '    ';

    function getHoverAnalysisCache(allDecls, lookup, options = {}) {
        return options.analysisCache ||
            lookup?.getSemanticAnalysisCache?.() ||
            createHoverTypeAnalysisCache(allDecls, lookup);
    }

    function buildSignatureArrowLine(length, spans) {
        if (!Number.isInteger(length) || length <= 0 || !spans.length) return '';

        const cells = new Array(length).fill(' ');
        for (const span of spans) {
            const start = Math.max(0, Math.min(length, span.start || 0));
            const end = Math.max(start, Math.min(length, span.end || start));
            for (let index = start; index < end; index++) {
                cells[index] = '^';
            }
        }

        let output = '';
        let activeKind = null;

        const flushKind = () => {
            if (activeKind === 'error') output += SIG_ERROR_CLOSE;
            else if (activeKind === 'active') output += SIG_ACTIVE_CLOSE;
            activeKind = null;
        };

        const setKind = nextKind => {
            if (activeKind === nextKind) return;
            flushKind();
            if (nextKind === 'error') output += SIG_ERROR_OPEN;
            else if (nextKind === 'active') output += SIG_ACTIVE_OPEN;
            activeKind = nextKind;
        };

        for (let index = 0; index < cells.length; index++) {
            const char = cells[index];
            const span = spans.find(item => index >= item.start && index < item.end) || null;
            setKind(char === '^' ? span?.kind || null : null);
            output += char;
        }

        flushKind();
        return output.trimEnd();
    }

    function buildWrappedSignatureText(header, paramStates, wrapWidth = SIGNATURE_WRAP_WIDTH) {
        const lines = [{ text: header, spans: [] }];
        const indent = SIGNATURE_CONTINUATION_INDENT;

        const pushNewLine = initialText => {
            const line = { text: initialText, spans: [] };
            lines.push(line);
            return line;
        };

        for (let index = 0; index < paramStates.length; index++) {
            const state = paramStates[index];
            const paramText = String(state?.text || '');
            let currentLine = lines[lines.length - 1];

            if (index === 0) {
                const start = currentLine.text.length;
                currentLine.text += paramText;
                const end = currentLine.text.length;
                if (state?.kind) currentLine.spans.push({ start, end, kind: state.kind });
                continue;
            }

            const inlineChunk = `, ${paramText}`;
            const wouldOverflow = currentLine.text.length + inlineChunk.length + 1 > wrapWidth;
            const canWrap = currentLine.text.length > header.length;

            if (wouldOverflow && canWrap) {
                currentLine.text += ',';
                currentLine = pushNewLine(indent);
                const start = currentLine.text.length;
                currentLine.text += paramText;
                const end = currentLine.text.length;
                if (state?.kind) currentLine.spans.push({ start, end, kind: state.kind });
                continue;
            }

            currentLine.text += ', ';
            const start = currentLine.text.length;
            currentLine.text += paramText;
            const end = currentLine.text.length;
            if (state?.kind) currentLine.spans.push({ start, end, kind: state.kind });
        }

        const lastLine = lines[lines.length - 1];
        if (lastLine.text.length + 1 > wrapWidth && lastLine.text.length > header.length) {
            pushNewLine(indent + ')');
        } else {
            lastLine.text += ')';
        }

        const outputLines = [];
        for (const line of lines) {
            outputLines.push(line.text);
            const arrowLine = buildSignatureArrowLine(line.text.length, line.spans || []);
            if (arrowLine) outputLines.push(arrowLine);
        }
        return outputLines.join('\n');
    }

    const isIdentifierBoundaryChar = isPawnIdentifierBoundaryChar;

    function findMatchingParenInDocs(source, openIndex) {
        return findBalancedGroupEnd(source, openIndex, '(', ')');
    }

    function getDocumentedSignatureParams(data, expectedCount) {
        if (!isFunctionLikeDefineDecl(data)) return null;
        const docs = String(data?.docs || '');
        if (!docs || docs.indexOf('(') < 0) return null;

        const names = [];
        for (const name of [data.hoverDisplayName, data.name]) {
            const text = String(name || '').trim();
            if (text && !names.includes(text)) names.push(text);
        }
        for (const name of names) {
            let cursor = 0;
            while (cursor < docs.length) {
                const nameIndex = docs.indexOf(name, cursor);
                if (nameIndex < 0) break;
                cursor = nameIndex + name.length;
                if (
                    !isIdentifierBoundaryChar(docs[nameIndex - 1] || '') ||
                    !isIdentifierBoundaryChar(docs[nameIndex + name.length] || '')
                ) {
                    continue;
                }

                let openIndex = nameIndex + name.length;
                while (openIndex < docs.length && /\s/.test(docs[openIndex])) openIndex++;
                if (docs[openIndex] !== '(') continue;

                const closeIndex = findMatchingParenInDocs(docs, openIndex);
                if (closeIndex <= openIndex) continue;

                const pieces = splitTopLevel(docs.slice(openIndex + 1, closeIndex))
                    .map(part => part.trim())
                    .filter(Boolean);
                if (!pieces.length) continue;
                if (Number.isInteger(expectedCount) && expectedCount > 0 && pieces.length !== expectedCount) {
                    continue;
                }
                return pieces;
            }
        }
        return null;
    }

    function buildColoredSignatureLine(data, currentArgIndex, callSiteArgs, allDecls, options = {}) {
        const {
            validateArgs = true,
            validationMode = 'call',
            lookup = null,
            precomputedCallArgLayout = null,
            includeWarnings = true
        } = options;
        const tag = data.typeTag ? `${data.typeTag}:` : '';
        const mods = (data.modifiers || []).join(' ');
        const pre = mods ? mods + ' ' : '';
        const analysisCache = getHoverAnalysisCache(allDecls, lookup, options);
        const paramsSource = data.args || '';
        const params = splitTopLevel(paramsSource);
        const isMacroDefine = isFunctionLikeDefineDecl(data);
        const displayParams = getDocumentedSignatureParams(data, params.length) || params;
        const macroCallSiteArgs = isMacroDefine && params.length === 1
            ? [String((callSiteArgs || []).join(', ')).trim()]
            : callSiteArgs;
        const macroCurrentArgIndex = isMacroDefine && params.length === 1 && currentArgIndex != null
            ? 0
            : currentArgIndex;
        const displayName = data.hoverDisplayName || data.name;
        const header = `${pre}${tag}${displayName}(`;
        const renderedParams = displayParams.map(p => p.trim());
        const spans = [];
        const issuePlan = validateArgs
            ? collectCallArgumentIssues(paramsSource, macroCallSiteArgs, allDecls, analysisCache, {
                rawCurrentArgIndex: macroCurrentArgIndex,
                validationMode,
                isMacroDefine,
                includeWarnings,
                includeMissingArguments: true,
                precomputedLayout: isMacroDefine ? null : precomputedCallArgLayout
            })
            : {
                layout: buildCallArgLayout(paramsSource, macroCallSiteArgs, macroCurrentArgIndex),
                issues: []
            };
        const layout = issuePlan.layout;
        const variadicIndex = layout.variadicIndex;
        const isVariadic = variadicIndex >= 0;
        const issueDetails = [];
        const issuesByParamIndex = new Map();
        const trailingIssues = [];
        for (const issue of issuePlan.issues || []) {
            if (!issue?.reason) continue;
            const detail = {
                index: issue.paramIndex,
                paramText: String(issue.paramText || issue.actualExpr || 'arg').trim() || 'arg',
                actualExpr: String(issue.actualExpr || '').trim(),
                reason: issue.reason,
                status: issue.status || 'error'
            };
            issueDetails.push(detail);
            if (Number.isInteger(issue.paramIndex) && issue.paramIndex >= 0 && issue.paramIndex < params.length) {
                if (!issuesByParamIndex.has(issue.paramIndex)) issuesByParamIndex.set(issue.paramIndex, []);
                issuesByParamIndex.get(issue.paramIndex).push(detail);
            } else {
                trailingIssues.push(detail);
            }
        }
        const paramStates = params.map((p, idx) => {
            const pStr = renderedParams[idx] || p.trim();
            const isCurrent = idx === layout.currentParamIndex ||
                (isVariadic && idx === variadicIndex && layout.currentParamIndex === variadicIndex);
            const paramIssues = issuesByParamIndex.get(idx) || [];

            return {
                text: pStr,
                kind: paramIssues.length ? 'error' : (isCurrent ? 'active' : null)
            };
        });

        const visibleParts = [...renderedParams];
        if (validateArgs && !isMacroDefine && trailingIssues.length) {
            for (const issue of trailingIssues) {
                const issueText = String(issue.paramText || issue.actualExpr || 'arg').trim() || 'arg';
                visibleParts.push(issueText);
                paramStates.push({
                    text: issueText,
                    kind: 'error'
                });
            }
        }

        if (!visibleParts.length) {
            return {
                text: `${header})`,
                errorDetails: issueDetails
            };
        }

        let signatureLine = header;
        for (let index = 0; index < visibleParts.length; index++) {
            if (index > 0) signatureLine += ', ';
            const start = signatureLine.length;
            const text = visibleParts[index];
            signatureLine += text;
            const end = signatureLine.length;
            const state = paramStates[index];
            if (state?.kind) spans.push({ start, end, kind: state.kind });
        }
        signatureLine += ')';

        const renderedText = signatureLine.length > SIGNATURE_WRAP_WIDTH
            ? buildWrappedSignatureText(header, paramStates)
            : (() => {
                const arrowLine = buildSignatureArrowLine(signatureLine.length, spans);
                return arrowLine ? `${signatureLine}\n${arrowLine}` : signatureLine;
            })();
        return {
            text: renderedText,
            errorDetails: issueDetails
        };
    }

    function getDisplayDimParts(dimsText) {
        return parseDimsParts(dimsText);
    }

    function buildColoredVariableAccessLine(data, accessSuffix, allDecls, activeDimIndex = null, lookup = null, options = {}) {
        if (data?.type !== 'variable' || !data?.dims || !accessSuffix) return null;
        const {
            validateAccess = true,
            includeWarnings = true
        } = options;

        const indexedExpr = parseIndexedAccessExpression(`${data.name}${accessSuffix}`, {
            allowEmptyIndexAccesses: true
        });
        if (!indexedExpr?.accesses?.length) return null;

        const signatureLine = buildSig(data, { allDecls, lookup });
        const displayIndexedExpr = data.hoverDisplayName
            ? parseIndexedAccessExpression(data.hoverDisplayName, {
                allowEmptyIndexAccesses: true
            })
            : null;
        const displayedAccesses = Array.isArray(displayIndexedExpr?.accesses)
            ? displayIndexedExpr.accesses
            : [];
        const analysisCache = getHoverAnalysisCache(allDecls, lookup, options);
        const accessExprs = indexedExpr.accesses.map(access => access.slice(1, -1).trim());
        const accessChain = resolveIndexedAccessValidationChain(data, accessExprs, allDecls, analysisCache);
        if (!accessChain.length) return null;
        const spans = [];
        const errorDetails = [];
        let hasErrors = false;
        const dimsText = data.dims || '';
        const displayDimParts = getDisplayDimParts(dimsText);
        const nameStart = signatureLine.indexOf(data.name);
        const displayBaseName = displayIndexedExpr?.baseName || data.name;
        let searchFrom = nameStart >= 0
            ? nameStart + displayBaseName.length
            : 0;

        for (let index = 0; index < accessChain.length; index++) {
            const expectedDimPart = accessChain[index]?.expectedDimPart;
            if (expectedDimPart == null) break;

            const expectedDimText = `[${expectedDimPart}]`;
            const displayedAccessText = displayedAccesses[index] || '';
            const visibleDimPart = displayDimParts[index] != null ? displayDimParts[index] : expectedDimPart;
            const spanText = displayedAccessText || `[${visibleDimPart}]`;
            const spanStart = signatureLine.indexOf(spanText, Math.max(0, searchFrom));
            if (spanStart < 0) continue;

            let kind = index === activeDimIndex ? 'active' : null;
            if (validateAccess && index < accessExprs.length) {
                const actualExpr = accessExprs[index];
                const result = explainIndexedAccessDimCompat(expectedDimPart, actualExpr, allDecls, {
                    analysisCache
                });
                if (result.status === 'error' || (result.status === 'warn' && includeWarnings)) {
                    kind = 'error';
                    hasErrors = true;
                    errorDetails.push({
                        index,
                        dimText: expectedDimText,
                        actualExpr,
                        reason: result.reason,
                        status: result.status || 'error'
                    });
                }
            }

            if (kind) {
                spans.push({
                    start: spanStart,
                    end: spanStart + spanText.length,
                    kind
                });
            }
            searchFrom = spanStart + spanText.length;
        }

        if (validateAccess) {
            const firstExtraIndex = accessChain.findIndex(step => step.expectedDimPart == null);
            const hasExtraIndexes = firstExtraIndex >= 0
                ? accessExprs.length > firstExtraIndex
                : accessExprs.length > accessChain.length;
            if (hasExtraIndexes && spans.length) {
                spans[spans.length - 1].kind = 'error';
                hasErrors = true;
                errorDetails.push({
                    index: firstExtraIndex >= 0 ? firstExtraIndex : accessChain.length,
                    dimText: '(extra index)',
                    actualExpr: accessExprs.slice(firstExtraIndex >= 0 ? firstExtraIndex : accessChain.length).join(', '),
                    reason: t('validation.extraIndexAccess')
                });
            }
        }

        const arrowLine = buildSignatureArrowLine(signatureLine.length, spans);
        if (!arrowLine) return null;
        return {
            text: `${signatureLine}\n${arrowLine}`,
            errorDetails,
            hasErrors
        };
    }

    return {
        buildColoredSignatureLine,
        buildColoredVariableAccessLine
    };
}

module.exports = { createHoverSignatureFeature };
