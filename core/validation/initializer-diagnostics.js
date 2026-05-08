function createInitializerDiagnostics(deps) {
    const {
        maxPawnArrayDimensions = 4,
        isEscapedQuote,
        unwrapExpressionForValidation,
        stripTagCastsForValidation,
        evaluatePawnNumericExpr,
        parseBraceArrayLiteralExpression,
        findUnresolvedReferenceNames,
        parseDimsParts,
        parseDimSpec,
        measurePawnStringLiteral,
        collectInvalidPawnCodeCharacterRuns
    } = deps;

    function findBalancedBraceLiteralEnd(source, escapeChar) {
        const text = String(source || '').trim();
        if (!text.startsWith('{')) return -1;
        let depth = 0;
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
            if (char === '{') {
                depth++;
                continue;
            }
            if (char === '}') {
                depth--;
                if (depth === 0) return index;
            }
        }
        return -1;
    }

    function isOpenMultilineBraceInitializerLine(source) {
        const text = String(source || '').trim();
        if (!/=/.test(text) || !/\{\s*$/.test(text)) return false;
        const rhs = text.slice(text.indexOf('=') + 1).trim();
        if (!rhs.startsWith('{')) return false;
        return !/}\s*$/.test(rhs);
    }

    function isOpenMultilineBraceInitializerForCurrentDecl(trimmedLine, currentVariableDecls = [], lineNumber = -1) {
        if (!isOpenMultilineBraceInitializerLine(trimmedLine)) return false;
        return currentVariableDecls.some(decl =>
            decl?.type === 'variable' &&
            decl.lineNumber === lineNumber &&
            String(decl.value || '').trim().startsWith('{') &&
            String(decl.value || '').includes('}')
        );
    }

    function findInitializerConstantDecl(name, allDecls, analysisCache) {
        return analysisCache?.findAnyDeclByName?.(name) ||
            (allDecls || []).find(item => item?.name === name) ||
            null;
    }

    function resolveConstantStringLiteralExpression(source, allDecls, analysisCache = null, seen = new Set()) {
        const expr = unwrapExpressionForValidation(source);
        if (!expr) return '';
        if (expr.startsWith('"')) return expr;
        const identifierName = expr.match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
        if (!identifierName || seen.has(identifierName)) return '';
        const decl = findInitializerConstantDecl(identifierName, allDecls, analysisCache);
        if (decl?.type !== 'define' || decl.args) return '';
        const defineValue = String(decl.value || '').trim();
        if (!defineValue || defineValue === identifierName) return '';
        seen.add(identifierName);
        const resolved = resolveConstantStringLiteralExpression(defineValue, allDecls, analysisCache, seen);
        seen.delete(identifierName);
        return resolved;
    }

    function isKnownConstantInitializerExpression(source, allDecls, escapeChar, analysisCache = null) {
        let expr = unwrapExpressionForValidation(source);
        if (!expr) return false;

        const tagStripped = stripTagCastsForValidation(expr);
        if (tagStripped && tagStripped !== expr) {
            return isKnownConstantInitializerExpression(tagStripped, allDecls, escapeChar, analysisCache);
        }

        if (expr.startsWith('"') || expr.startsWith("'")) return true;
        if (/^-?(?:\d+|\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(expr)) return true;
        if (expr === 'true' || expr === 'false' || expr === 'cellmin' || expr === 'cellmax') return true;
        if (evaluatePawnNumericExpr(expr, allDecls, new Set(), analysisCache) != null) return true;

        const identifierName = expr.match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
        if (identifierName) {
            const decl = findInitializerConstantDecl(identifierName, allDecls, analysisCache);
            if (decl?.type === 'define' && !decl.args) {
                const defineValue = String(decl.value || '').trim();
                if (defineValue && defineValue !== identifierName) {
                    return isKnownConstantInitializerExpression(defineValue, allDecls, escapeChar, analysisCache);
                }
            }
            if (decl?.type === 'enum' || decl?.type === 'enum-item') return true;
            if (decl) return false;
        }

        const braceParts = parseBraceArrayLiteralExpression(expr, escapeChar);
        if (braceParts) {
            return braceParts.every(part =>
                isKnownConstantInitializerExpression(part, allDecls, escapeChar, analysisCache) === true
            );
        }

        const unresolved = findUnresolvedReferenceNames(expr, allDecls, analysisCache, escapeChar);
        if (unresolved.length) return null;
        return /[A-Za-z_@]\w*/.test(expr) ? false : null;
    }

    function explainArrayInitializerIssue(decl, allDecls, escapeChar, analysisCache = null) {
        if (!decl?.dims || !decl?.value) return null;

        const dimParts = parseDimsParts(decl.dims || '');
        if (!dimParts.length) return null;
        const dimSpecs = dimParts.map(part =>
            analysisCache?.getDimSpec?.(part) || parseDimSpec(part, allDecls, new Set(), analysisCache)
        );
        const valueText = String(decl.value || '').trim();
        if (collectInvalidPawnCodeCharacterRuns(valueText, escapeChar).length) {
            return null;
        }
        if (valueText.startsWith('{')) {
            const balancedBraceEnd = findBalancedBraceLiteralEnd(valueText, escapeChar);
            if (balancedBraceEnd >= 0 && valueText.slice(balancedBraceEnd + 1).trim()) {
                return null;
            }
        }
        const validateLeafArrayValue = (source, dimSpec) => {
            const trimmedSource = String(source || '').trim();
            if (!trimmedSource) {
                return { kind: 'partial' };
            }

            if (trimmedSource.startsWith('"')) {
                const measured = measurePawnStringLiteral?.(trimmedSource, escapeChar);
                if (dimSpec?.capacity != null && measured?.bytesWithTerminator > dimSpec.capacity) {
                    return { kind: 'overflow' };
                }
                return null;
            }

            const resolvedStringLiteral = resolveConstantStringLiteralExpression(trimmedSource, allDecls, analysisCache);
            if (resolvedStringLiteral) {
                const measured = measurePawnStringLiteral?.(resolvedStringLiteral, escapeChar);
                if (dimSpec?.capacity != null && measured?.bytesWithTerminator > dimSpec.capacity) {
                    return { kind: 'overflow' };
                }
                return null;
            }

            const braceParts = parseBraceArrayLiteralExpression(trimmedSource, escapeChar);
            if (!braceParts) {
                return { kind: 'partial' };
            }
            if (dimSpec?.capacity != null && braceParts.length > dimSpec.capacity) {
                return { kind: 'overflow' };
            }
            for (const part of braceParts) {
                if (isKnownConstantInitializerExpression(part, allDecls, escapeChar, analysisCache) === false) {
                    return { kind: 'constantRequired' };
                }
            }
            return null;
        };
        const findEnumDeclForDimSpec = dimSpec => {
            const enumName = String(dimSpec?.enumName || '').trim();
            if (!enumName) return null;
            const enumDecl = findInitializerConstantDecl(enumName, allDecls, analysisCache);
            return enumDecl?.type === 'enum' ? enumDecl : null;
        };
        const getArrayFieldDimSpecs = fieldDecl => {
            const fieldDims = parseDimsParts(fieldDecl?.dims || '');
            return fieldDims.map(part =>
                analysisCache?.getDimSpec?.(part) ||
                parseDimSpec(part, allDecls, new Set(), analysisCache)
            );
        };
        const validateArrayValueAgainstDimSpecs = (source, arrayDimSpecs, dimIndex = 0) => {
            if (!arrayDimSpecs.length) return null;
            const dimSpec = arrayDimSpecs[dimIndex] || null;
            const trimmedSource = String(source || '').trim();
            if (!trimmedSource) return null;

            if (dimIndex >= arrayDimSpecs.length - 1) {
                return validateLeafArrayValue(trimmedSource, dimSpec);
            }

            const braceParts = parseBraceArrayLiteralExpression(trimmedSource, escapeChar);
            if (!braceParts) {
                return null;
            }
            if (dimSpec?.capacity != null && braceParts.length > dimSpec.capacity) {
                return { kind: 'overflow' };
            }
            if (dimSpec?.raw && dimSpec.capacity != null && braceParts.length < dimSpec.capacity) {
                return { kind: 'partial' };
            }
            for (const part of braceParts) {
                const nestedIssue = validateArrayValueAgainstDimSpecs(part, arrayDimSpecs, dimIndex + 1);
                if (nestedIssue) return nestedIssue;
            }
            return null;
        };
        const validateEnumStructFieldInitializer = (source, fieldDecl) => {
            const fieldDimSpecs = getArrayFieldDimSpecs(fieldDecl);
            if (!fieldDimSpecs.length) return null;
            const trimmedSource = String(source || '').trim();
            if (
                !trimmedSource.startsWith('{') &&
                !trimmedSource.startsWith('"') &&
                !resolveConstantStringLiteralExpression(trimmedSource, allDecls, analysisCache)
            ) {
                return null;
            }
            const issue = validateArrayValueAgainstDimSpecs(source, fieldDimSpecs);
            return issue?.kind === 'overflow'
                ? {
                    kind: 'enumFieldInitializerOverflow',
                    fieldName: fieldDecl?.name || ''
                }
                : issue;
        };
        const validateEnumStructInitializer = (source, dimSpec) => {
            const enumDecl = findEnumDeclForDimSpec(dimSpec);
            const enumMembers = Array.isArray(enumDecl?.enumMembers) ? enumDecl.enumMembers : [];
            if (!enumMembers.length) return null;
            const isStructLikeEnum =
                enumMembers.some(member => !!member?.dims) ||
                (dimSpec?.capacity != null && dimSpec.capacity === enumMembers.length);
            if (!isStructLikeEnum) return null;
            const fieldParts = parseBraceArrayLiteralExpression(source, escapeChar);
            if (!fieldParts) return null;
            if (fieldParts.length > enumMembers.length) return { kind: 'enumFieldCountOverflow' };
            for (let index = 0; index < fieldParts.length; index++) {
                const fieldIssue = validateEnumStructFieldInitializer(fieldParts[index], enumMembers[index]);
                if (fieldIssue) return fieldIssue;
            }
            return null;
        };

        const checkRecursive = (source, dimIndex) => {
            const dimSpec = dimSpecs[dimIndex] || null;
            const braceParts = parseBraceArrayLiteralExpression(source, escapeChar);
            if (!braceParts) {
                if (dimIndex < dimSpecs.length - 1) {
                    return { kind: 'partial' };
                }
                return null;
            }

            if (dimSpec?.capacity != null && braceParts.length > dimSpec.capacity) {
                return { kind: 'overflow' };
            }
            if (
                dimIndex < dimSpecs.length - 1 &&
                dimSpec?.raw &&
                dimSpec.capacity != null &&
                braceParts.length < dimSpec.capacity
            ) {
                return { kind: 'partial' };
            }
            if (dimIndex >= dimSpecs.length - 1) {
                const enumStructIssue = validateEnumStructInitializer(source, dimSpec);
                if (enumStructIssue) return enumStructIssue;
                for (const part of braceParts) {
                    if (isKnownConstantInitializerExpression(part, allDecls, escapeChar, analysisCache) === false) {
                        return { kind: 'constantRequired' };
                    }
                }
                return null;
            }

            for (const part of braceParts) {
                const nested = String(part || '').trim();
                if (dimIndex + 1 === dimSpecs.length - 1) {
                    const enumStructIssue = validateEnumStructInitializer(nested, dimSpecs[dimIndex + 1] || null);
                    if (enumStructIssue) return enumStructIssue;
                    const leafIssue = validateLeafArrayValue(nested, dimSpecs[dimIndex + 1] || null);
                    if (leafIssue) return leafIssue;
                    continue;
                }
                if (!nested.startsWith('{')) {
                    return { kind: 'partial' };
                }
                const nestedIssue = checkRecursive(nested, dimIndex + 1);
                if (nestedIssue) return nestedIssue;
            }
            return null;
        };

        if (dimSpecs.length === 1 && valueText.startsWith('"')) {
            const measured = measurePawnStringLiteral?.(valueText, escapeChar);
            if (dimSpecs[0]?.capacity != null && measured?.bytesWithTerminator > dimSpecs[0].capacity) {
                return { kind: 'overflow' };
            }
            return null;
        }

        if (dimSpecs.length > 1 && valueText && !valueText.startsWith('{')) {
            return { kind: 'partial' };
        }

        return checkRecursive(valueText, 0);
    }

    function findInvalidArraySizeIssue(decl, allDecls, analysisCache = null) {
        if (!decl?.dims) return null;
        const dimParts = parseDimsParts(decl.dims || '');
        if (!dimParts.length) return null;
        if (dimParts.length > maxPawnArrayDimensions) {
            return {
                kind: 'tooManyDimensions',
                dimText: `[${dimParts[maxPawnArrayDimensions]}]`,
                dimIndex: maxPawnArrayDimensions
            };
        }
        if (!decl.isArg && !decl.value && dimParts[dimParts.length - 1] === '') {
            return {
                kind: 'invalidSize',
                dimText: '[]',
                dimIndex: dimParts.length - 1
            };
        }
        for (let index = 0; index < dimParts.length; index++) {
            const dimSpec = analysisCache?.getDimSpec?.(dimParts[index]) ||
                parseDimSpec(dimParts[index], allDecls, new Set(), analysisCache);
            if (!dimSpec?.raw || dimSpec.capacity == null) continue;
            if (dimSpec.capacity <= 0) {
                return {
                    kind: 'invalidSize',
                    dimText: `[${dimSpec.raw}]`,
                    dimIndex: index
                };
            }
        }
        return null;
    }

    return {
        isOpenMultilineBraceInitializerLine,
        isOpenMultilineBraceInitializerForCurrentDecl,
        resolveConstantStringLiteralExpression,
        isKnownConstantInitializerExpression,
        explainArrayInitializerIssue,
        findInvalidArraySizeIssue
    };
}

module.exports = { createInitializerDiagnostics };
