const { isPreprocessorDirectiveLine } = require('../syntax/preprocessor-lines');
const { hasTrailingBackslashContinuation } = require('../syntax/continuation');
const { readPawnAssignmentOperatorAt } = require('../syntax/operators');
const { PAWN_IDENTIFIER_SOURCE } = require('../syntax/identifiers');
const { getTypeAnalysisSourceDecls } = require('./type-analysis-cache');
const {
    advanceTopLevelScannerState,
    createTopLevelScannerState,
    findTopLevelAssignmentOperatorIndex: findTopLevelAssignmentOperatorIndexCore
} = require('../syntax/top-level');
const {
    startsWithControlKeyword,
    startsWithDeclarationKeyword
} = require('../syntax/keywords');

function createSharedExpressionDiagnostics(deps) {
    const {
        vscode,
        t,
        areWarningDiagnosticsEnabled,
        getWarningSeverity,
        getCoreArrayShapeIssue,
        stripTrailingSemicolon,
        stripTagCastsForValidation,
        splitTopLevel,
        explainParamDeclCompat,
        isFunctionLikeDefineDecl,
        isFunctionLikeDecl,
        parseDimsParts,
        parseDimSpec,
        getEffectiveDeclDimParts,
        findFirstNonWhitespaceIndex,
        findBalancedGroupEnd,
        readIdentifierAt,
        isOperatorOverloadName
    } = deps;

    function getLiveArrayShapeIssue(expectedDims, actualDims, actualExpr, decls, analysisCache, options = {}) {
        const shapeOptions = typeof options === 'string'
            ? { escapeChar: options }
            : { ...(options || {}) };
        const issue = getCoreArrayShapeIssue(
            expectedDims,
            actualDims,
            actualExpr,
            decls,
            analysisCache,
            shapeOptions
        );
        if (issue?.status === 'warn' && !areWarningDiagnosticsEnabled()) return null;
        return issue
            ? {
                ...issue,
                severity: issue.status === 'warn'
                    ? getWarningSeverity()
                    : vscode.DiagnosticSeverity.Error
            }
            : null;
    }



    function extractLeadingIdentifierName(source) {
        const text = String(source || '').trim();
        const readNameAt = index => {
            const ident = readIdentifierAt(text, index);
            return ident ? { name: ident.text || ident.name || '', end: ident.end } : null;
        };
        const readTagTargetName = tagEnd => {
            const colonIndex = findFirstNonWhitespaceIndex(text, tagEnd);
            if (text[colonIndex] !== ':') return '';
            const nameStart = findFirstNonWhitespaceIndex(text, colonIndex + 1);
            return readNameAt(nameStart)?.name || '';
        };

        if (text.startsWith('{')) {
            const tagEnd = findBalancedGroupEnd(text, 0, '{', '}');
            if (tagEnd > 0) {
                const taggedName = readTagTargetName(tagEnd + 1);
                if (taggedName) return taggedName;
            }
        }

        const leading = readNameAt(0);
        if (!leading) return '';
        const taggedName = readTagTargetName(leading.end);
        return taggedName || leading.name;
    }



    function matchesCurrentDeclarationAssignmentLhs(expr, currentVariableDecls = [], lineNumber = -1) {
        const source = stripTrailingSemicolon(expr);
        if (!source) return false;
        const normalizedSource = source.replace(/\s+/g, '');
        const lhsName = extractLeadingIdentifierName(source);
        if (!lhsName) return false;

        return currentVariableDecls.some(decl => {
            if (decl?.type !== 'variable') return false;
            if (decl.lineNumber !== lineNumber) return false;
            if (decl.name !== lhsName) return false;

            const fragment = `${decl.typeTag ? `${decl.typeTag}:` : ''}${decl.name}${decl.dims || ''}`.replace(/\s+/g, '');
            if (!fragment) return false;

            return normalizedSource === fragment || normalizedSource === `const${fragment}`;
        });
    }



    function findTopLevelAssignmentOperatorIndex(lineText) {
        return findTopLevelAssignmentOperatorIndexCore(lineText);
    }



    function getAssignmentOperatorText(lineText, operatorIndex) {
        return readPawnAssignmentOperatorAt(lineText, operatorIndex);
    }



    function isStandaloneMutationTargetCandidate(source) {
        const text = String(source || '').trim();
        if (!text) return false;
        if (startsWithDeclarationKeyword(text) || startsWithControlKeyword(text)) {
            return false;
        }
        if (/[=,;]/.test(text)) return false;
        if (/\s(?:&&|\|\||<<|>>|<=|>=|==|!=|[+\-*/%&|^<>])\s/.test(text)) return false;
        return true;
    }



    function parseStandaloneMutationStatement(source) {
        const raw = stripTrailingSemicolon(source);
        const leading = raw.match(/^\s*/)?.[0].length || 0;
        const text = raw.slice(leading);
        if (!text) return null;

        const prefix = text.match(/^(\+\+|--)\s*([\s\S]+?)\s*$/);
        if (prefix) {
            const target = prefix[2].trim();
            if (!isStandaloneMutationTargetCandidate(target)) return null;
            const targetStartInText = prefix[0].indexOf(prefix[2]);
            return {
                target,
                start: leading + targetStartInText + (prefix[2].length - prefix[2].trimStart().length),
                end: leading + targetStartInText + prefix[2].trimEnd().length
            };
        }

        const postfix = text.match(/^([\s\S]+?)\s*(\+\+|--)\s*$/);
        if (!postfix) return null;
        const target = postfix[1].trim();
        if (!isStandaloneMutationTargetCandidate(target)) return null;
        const targetStartInText = postfix[0].indexOf(postfix[1]);
        return {
            target,
            start: leading + targetStartInText + (postfix[1].length - postfix[1].trimStart().length),
            end: leading + targetStartInText + postfix[1].trimEnd().length
        };
    }



    function isPreprocessorContinuationLine(ctx, lineNumber) {
        const rawLines = ctx?.rawLines || [];
        if (!Array.isArray(rawLines) || lineNumber <= 0 || lineNumber >= rawLines.length) return false;

        for (let probe = lineNumber - 1; probe >= 0; probe--) {
            const candidate = String(rawLines[probe] || '');
            if (hasTrailingBackslashContinuation(candidate)) return true;
            if (candidate.trim()) return false;
        }

        return false;
    }



    function isPreprocessorDirectiveOrContinuationLine(ctx, lineNumber, strippedLineText = '') {
        return isPreprocessorDirectiveLine(strippedLineText) ||
            isPreprocessorContinuationLine(ctx, lineNumber);
    }



    function isFunctionLikeAliasWrapperDefine(decl) {
        if (!isFunctionLikeDefineDecl(decl)) return false;
        const valueText = String(decl?.value || '').trim();
        if (!valueText) return false;
        const target = readIdentifierAt(valueText, 0);
        if (!target) return false;
        const openParenIndex = findFirstNonWhitespaceIndex(valueText, target.end);
        if (valueText[openParenIndex] !== '(') return false;
        const targetName = target.text || target.name || '';
        return targetName !== decl.name;
    }



    function isSingleStatementForInitLine(lineText, declName = '') {
        const source = String(lineText || '').trim();
        if (!declName || !/^for\s*\(/.test(source)) return false;
        const tagSource = `(?:${PAWN_IDENTIFIER_SOURCE}|\\{[^}]+\\})`;
        return new RegExp(String.raw`^for\s*\(\s*new\s+(?:${tagSource}\s*:\s*)?${declName}\b`).test(source);
    }



    function compareFunctionDeclarationsByPrototype(expectedDecl, actualDecl, ctx, analysisCache) {
        if (!compareFunctionReturnByPrototype(expectedDecl, actualDecl, ctx, analysisCache)) return false;
        const analysisDecls = getTypeAnalysisSourceDecls(ctx, analysisCache);
        const expectedParams = splitTopLevel(expectedDecl.args || '');
        const actualParams = splitTopLevel(actualDecl.args || '');
        if (expectedParams.length !== actualParams.length) return false;

        for (let index = 0; index < expectedParams.length; index++) {
            const result = explainParamDeclCompat(expectedParams[index], actualParams[index], analysisDecls, { analysisCache });
            if (result.status !== 'ok') return false;
        }

        return true;
    }



    function compareFunctionReturnByPrototype(expectedDecl, actualDecl, ctx, analysisCache) {
        if (!expectedDecl || !actualDecl) return false;
        if ((expectedDecl.typeTag || '') !== (actualDecl.typeTag || '')) return false;
        const analysisDecls = getTypeAnalysisSourceDecls(ctx, analysisCache);
        const returnShapeIssue = getLiveArrayShapeIssue(
            expectedDecl.dims || '',
            actualDecl.dims || '',
            '',
            analysisDecls,
            analysisCache
        );
        if (returnShapeIssue) return false;
        return true;
    }



    function normalizeSelfAssignmentExpression(expr) {
        return stripTagCastsForValidation(expr)
            .replace(/\s+/g, '')
            .replace(/;$/, '');
    }



    function getConstMutationMessage(assignable, fallbackName) {
        return t('validation.cannotModifyConst', {
            name: assignable?.name || fallbackName || ''
        });
    }



    function findVariableDeclByName(ctx, analysisCache, name) {
        const symbolName = String(name || '').trim();
        if (!symbolName) return null;
        return analysisCache?.findAnyDeclByName?.(symbolName, item => item?.type === 'variable') ||
            ctx?.lookup?.findVariable?.(symbolName) ||
            ctx?.lookup?.findAnyDeclByName?.(symbolName, item => item?.type === 'variable') ||
            null;
    }



    function getDeclDimPartsForSizeof(decl) {
        if (!decl?.dims) return [];
        const effective = getEffectiveDeclDimParts(decl);
        return Array.isArray(effective) ? effective : parseDimsParts(decl.dims || '');
    }



    function isIndeterminateSizeofDimPart(dimPart, ctx, analysisCache) {
        const raw = String(dimPart ?? '').trim();
        if (!raw) return true;
        const decls = getTypeAnalysisSourceDecls(ctx, analysisCache);
        const spec = analysisCache?.getDimSpec?.(raw) ||
            parseDimSpec(raw, decls, new Set(), analysisCache);
        return !!spec?.raw && spec.capacity == null;
    }



    function getSizeofArrayIssue(operand, ctx, analysisCache = null) {
        if (!areWarningDiagnosticsEnabled()) return null;
        const decl = findVariableDeclByName(ctx, analysisCache, operand.name);
        if (!decl?.dims) return null;
        const dimParts = getDeclDimPartsForSizeof(decl);
        if (!dimParts.length) return null;
        if (operand.level >= dimParts.length) return null;
        if (!isIndeterminateSizeofDimPart(dimParts[operand.level], ctx, analysisCache)) return null;
        return {
            kind: 'indeterminateArraySize',
            start: operand.operatorStart,
            end: operand.end,
            name: operand.name,
            severity: getWarningSeverity()
        };
    }



    function parseSizeofOperandBrackets(text, offset) {
        let index = offset;
        let level = 0;
        while (index < text.length) {
            const next = findFirstNonWhitespaceIndex(text, index);
            if (text[next] !== '[') break;
            const closeIndex = findBalancedGroupEnd(text, next, '[', ']');
            if (closeIndex < 0) break;
            level++;
            index = closeIndex + 1;
        }
        return { level, end: index };
    }



    function stripOuterBalancedParens(text) {
        let source = String(text || '').trim();
        let offset = String(text || '').indexOf(source);
        while (source.startsWith('(')) {
            const closeIndex = findBalancedGroupEnd(source, 0, '(', ')');
            if (closeIndex !== source.length - 1) break;
            source = source.slice(1, -1).trim();
            offset += 1;
        }
        return { text: source, offset };
    }



    function parseSizeofOperandFromText(text, operandStart, operatorStart) {
        if (operandStart >= text.length) return null;

        if (text[operandStart] === '(') {
            const closeIndex = findBalancedGroupEnd(text, operandStart, '(', ')');
            if (closeIndex < 0) return null;
            const inner = text.slice(operandStart + 1, closeIndex);
            const stripped = stripOuterBalancedParens(inner);
            const ident = readIdentifierAt(stripped.text, 0);
            if (!ident) return null;
            const name = ident.text || ident.name || '';
            const bracketInfo = parseSizeofOperandBrackets(stripped.text, ident.end);
            if (stripped.text.slice(bracketInfo.end).trim()) return null;
            return {
                operatorStart,
                name,
                level: bracketInfo.level,
                end: closeIndex + 1
            };
        }

        const ident = readIdentifierAt(text, operandStart);
        if (!ident) return null;
        const bracketInfo = parseSizeofOperandBrackets(text, ident.end);
        return {
            operatorStart,
            name: ident.text,
            level: bracketInfo.level,
            end: Math.max(bracketInfo.end, ident.end)
        };
    }



    function findSizeofOperatorIssues(source, ctx, analysisCache = null) {
        const text = String(source || '');
        if (text.indexOf('sizeof') < 0) return [];
        const issues = [];
        let inStr = false;
        let strCh = '';

        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh) inStr = false;
                continue;
            }
            if (char === '"' || char === "'") {
                inStr = true;
                strCh = char;
                continue;
            }
            const ident = readIdentifierAt(text, index);
            if (!ident) continue;
            index = ident.end - 1;
            if (ident.text !== 'sizeof') continue;

            const operandStart = findFirstNonWhitespaceIndex(text, ident.end);
            if (operandStart >= text.length) continue;

            const operand = parseSizeofOperandFromText(text, operandStart, ident.start);
            if (!operand?.name) continue;
            const arrayIssue = getSizeofArrayIssue(operand, ctx, analysisCache);
            if (arrayIssue) {
                issues.push(arrayIssue);
                continue;
            }

            if (findVariableDeclByName(ctx, analysisCache, operand.name)) continue;
            const functionDecl = ctx?.lookup?.findAnyDeclByName?.(operand.name, item => isFunctionLikeDecl(item)) || null;
            if (!functionDecl) continue;
            issues.push({
                kind: 'function',
                start: ident.start,
                end: Math.max(operand.end, ident.end),
                name: operand.name
            });
        }

        return issues;
    }



    function findSizeofFunctionOperatorIssues(source, ctx, analysisCache = null) {
        return findSizeofOperatorIssues(source, ctx, analysisCache)
            .filter(issue => issue.kind === 'function');
    }

    function isBitwiseOrOrAndOperator(source, index) {
        const char = source[index] || '';
        if (char !== '&' && char !== '|') return false;
        const previous = source[index - 1] || '';
        const next = source[index + 1] || '';
        if (previous === char || next === char) return false;
        if (next === '=') return false;
        return true;
    }



    function readCompilerComparisonOperator(source, index) {
        const two = source.slice(index, index + 2);
        if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
            return {
                operator: two,
                kind: two === '==' || two === '!=' ? 'equality' : 'relational'
            };
        }
        const char = source[index] || '';
        if (char !== '<' && char !== '>') return '';
        const previous = source[index - 1] || '';
        const next = source[index + 1] || '';
        if (previous === char || next === char || next === '=') return '';
        return {
            operator: char,
            kind: 'relational'
        };
    }



    function readAssignmentOperatorForExpressionBoundary(source, index) {
        return readPawnAssignmentOperatorAt(source, index);
    }



    function findPossiblyUnintendedBitwiseOperationIssues(source) {
        if (!areWarningDiagnosticsEnabled()) return [];
        const text = String(source || '');
        if ((text.indexOf('&') < 0 && text.indexOf('|') < 0) || !/[<>=!&|]/.test(text)) return [];

        const segmentStates = new Map();
        const scannerState = createTopLevelScannerState();

        const getStateKey = () => `${scannerState.parenDepth}|${scannerState.bracketDepth}|${scannerState.braceDepth}`;
        const getState = () => {
            const key = getStateKey();
            let state = segmentStates.get(key);
            if (!state) {
                state = {
                    bitwiseSeen: false,
                    firstBitwise: null,
                    equalityCount: 0,
                    relationalCount: 0
                };
                segmentStates.set(key, state);
            }
            return state;
        };
        const resetCurrentState = () => {
            segmentStates.delete(getStateKey());
        };

        const issues = [];
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (advanceTopLevelScannerState(text, index, scannerState)) continue;
            if (char === ',' || char === ';') {
                resetCurrentState();
                continue;
            }
            const logicalOperator = text.slice(index, index + 2);
            if (logicalOperator === '&&' || logicalOperator === '||') {
                resetCurrentState();
                index++;
                continue;
            }
            const assignmentOperator = readAssignmentOperatorForExpressionBoundary(text, index);
            if (assignmentOperator) {
                resetCurrentState();
                index += assignmentOperator.length - 1;
                continue;
            }
            if (isBitwiseOrOrAndOperator(text, index)) {
                const state = getState();
                state.bitwiseSeen = true;
                if (!state.firstBitwise) {
                    state.firstBitwise = {
                        start: index,
                        end: index + 1
                    };
                }
                continue;
            }
            const comparison = readCompilerComparisonOperator(text, index);
            if (comparison) {
                const state = getState();
                const countKey = comparison.kind === 'equality' ? 'equalityCount' : 'relationalCount';
                if (state[countKey] > 0 && state.bitwiseSeen && state.firstBitwise) {
                    issues.push({
                        kind: 'possiblyUnintendedBitwiseOperation',
                        start: state.firstBitwise.start,
                        end: state.firstBitwise.end,
                        severity: getWarningSeverity()
                    });
                }
                state[countKey]++;
                index += comparison.operator.length - 1;
            }
        }
        return issues;
    }

    return {
        getLiveArrayShapeIssue,
        matchesCurrentDeclarationAssignmentLhs,
        findTopLevelAssignmentOperatorIndex,
        getAssignmentOperatorText,
        parseStandaloneMutationStatement,
        isPreprocessorContinuationLine,
        isPreprocessorDirectiveOrContinuationLine,
        isFunctionLikeAliasWrapperDefine,
        isSingleStatementForInitLine,
        compareFunctionDeclarationsByPrototype,
        compareFunctionReturnByPrototype,
        isOperatorOverloadName,
        normalizeSelfAssignmentExpression,
        getConstMutationMessage,
        findVariableDeclByName,
        findSizeofOperatorIssues,
        findSizeofFunctionOperatorIssues,
        findPossiblyUnintendedBitwiseOperationIssues
    };
}

module.exports = { createSharedExpressionDiagnostics };
