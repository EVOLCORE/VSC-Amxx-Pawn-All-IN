function createInitializerDiagnostics(deps) {
    const {
        maxPawnArrayDimensions = 4,
        isEscapedQuote,
        unwrapExpressionForValidation,
        stripTagCastsForValidation,
        evaluatePawnNumericExpr,
        parseBraceArrayLiteralExpression,
        parseBraceArrayLiteralExpressionDetailed,
        findUnresolvedReferenceNames,
        parseDimsParts,
        parseDimSpec,
        measurePawnStringLiteral,
        collectInvalidPawnCodeCharacterRuns
    } = deps;

    function getBraceArrayLiteralDetails(source, escapeChar) {
        return parseBraceArrayLiteralExpressionDetailed(source, escapeChar);
    }

    function readLeadingInitializerTokenIssue(source, rangeStart = 0, escapeChar = '') {
        const text = String(source || '');
        let cursor = 0;
        while (cursor < text.length && /\s/.test(text[cursor] || '')) cursor++;
        if (cursor >= text.length) return { kind: 'partial' };

        let end = cursor + 1;
        const first = text[cursor] || '';
        if (/[A-Za-z_@]/.test(first)) {
            while (end < text.length && /[A-Za-z0-9_@]/.test(text[end] || '')) end++;
        } else if (/[0-9]/.test(first)) {
            while (end < text.length && /[0-9_]/.test(text[end] || '')) end++;
            if (text[end] === '.') {
                end++;
                while (end < text.length && /[0-9_]/.test(text[end] || '')) end++;
            }
        } else if (first === '.') {
            while (end < text.length && /[0-9_]/.test(text[end] || '')) end++;
        } else if (first === '"' || first === "'") {
            const quote = first;
            while (end < text.length) {
                if (text[end] === quote && !isEscapedQuote(text, end, escapeChar)) {
                    end++;
                    break;
                }
                end++;
            }
        } else {
            while (end < text.length && !/\s/.test(text[end] || '') && !/[,;[\](){}]/.test(text[end] || '')) end++;
        }

        let trailingCursor = end;
        let hasTrailingCode = false;
        while (trailingCursor < text.length) {
            if (/\s/.test(text[trailingCursor] || '')) {
                trailingCursor++;
                continue;
            }
            if (text[trailingCursor] === '/' && text[trailingCursor + 1] === '/') {
                trailingCursor += 2;
                while (trailingCursor < text.length && text[trailingCursor] !== '\n') trailingCursor++;
                continue;
            }
            if (text[trailingCursor] === '/' && text[trailingCursor + 1] === '*') {
                trailingCursor += 2;
                while (trailingCursor < text.length && !(text[trailingCursor] === '*' && text[trailingCursor + 1] === '/')) {
                    trailingCursor++;
                }
                trailingCursor = Math.min(text.length, trailingCursor + 2);
                continue;
            }
            hasTrailingCode = true;
            break;
        }

        return {
            kind: 'unexpectedToken',
            token: text.slice(cursor, Math.max(cursor + 1, end)),
            start: rangeStart + cursor,
            end: rangeStart + Math.max(cursor + 1, end),
            hasTrailingCode
        };
    }

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
        const validateLeafArrayValue = (source, dimSpec, rangeStart = 0) => {
            const trimmedSource = String(source || '').trim();
            if (!trimmedSource) {
                return { kind: 'partial' };
            }

            if (trimmedSource.startsWith('"')) {
                const measured = measurePawnStringLiteral(trimmedSource, escapeChar);
                if (dimSpec?.capacity != null && measured?.bytesWithTerminator > dimSpec.capacity) {
                    return { kind: 'overflow' };
                }
                return null;
            }

            const resolvedStringLiteral = resolveConstantStringLiteralExpression(trimmedSource, allDecls, analysisCache);
            if (resolvedStringLiteral) {
                const measured = measurePawnStringLiteral(resolvedStringLiteral, escapeChar);
                if (dimSpec?.capacity != null && measured?.bytesWithTerminator > dimSpec.capacity) {
                    return { kind: 'overflow' };
                }
                return null;
            }

            const braceDetails = getBraceArrayLiteralDetails(trimmedSource, escapeChar);
            if (!braceDetails?.parts) {
                const tokenIssue = readLeadingInitializerTokenIssue(source, rangeStart, escapeChar);
                return tokenIssue.hasTrailingCode ? tokenIssue : { kind: 'partial' };
            }
            const braceParts = braceDetails.parts.map(part => part.text);
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
        const validateArrayValueAgainstDimSpecs = (source, arrayDimSpecs, dimIndex = 0, rangeStart = 0) => {
            if (!arrayDimSpecs.length) return null;
            const dimSpec = arrayDimSpecs[dimIndex] || null;
            const trimmedSource = String(source || '').trim();
            if (!trimmedSource) return null;

            if (dimIndex >= arrayDimSpecs.length - 1) {
                return validateLeafArrayValue(trimmedSource, dimSpec, rangeStart);
            }

            const braceDetails = getBraceArrayLiteralDetails(trimmedSource, escapeChar);
            if (!braceDetails?.parts) {
                return null;
            }
            const braceParts = braceDetails.parts.map(part => part.text);
            if (dimSpec?.capacity != null && braceParts.length > dimSpec.capacity) {
                return { kind: 'overflow' };
            }
            if (dimSpec?.raw && dimSpec.capacity != null && braceParts.length < dimSpec.capacity) {
                return { kind: 'partial' };
            }
            for (let index = 0; index < braceDetails.parts.length; index++) {
                const part = braceDetails.parts[index];
                const nestedIssue = validateArrayValueAgainstDimSpecs(
                    part.text,
                    arrayDimSpecs,
                    dimIndex + 1,
                    part.start >= 0 ? rangeStart + 1 + part.start : rangeStart
                );
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
            const fieldDetails = getBraceArrayLiteralDetails(source, escapeChar);
            const fieldParts = fieldDetails?.parts?.map(part => part.text) || null;
            if (!fieldParts) return null;
            if (fieldParts.length > enumMembers.length) return { kind: 'enumFieldCountOverflow' };
            for (let index = 0; index < fieldParts.length; index++) {
                const fieldIssue = validateEnumStructFieldInitializer(fieldParts[index], enumMembers[index]);
                if (fieldIssue) return fieldIssue;
            }
            return null;
        };

        const checkRecursive = (source, dimIndex, rangeStart = 0) => {
            const dimSpec = dimSpecs[dimIndex] || null;
            const braceDetails = getBraceArrayLiteralDetails(source, escapeChar);
            const braceParts = braceDetails?.parts?.map(part => part.text) || null;
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

            for (let index = 0; index < braceDetails.parts.length; index++) {
                const part = braceDetails.parts[index];
                const nested = String(part.text || '').trim();
                const partRangeStart = part.start >= 0 ? rangeStart + 1 + part.start : rangeStart;
                if (dimIndex + 1 === dimSpecs.length - 1) {
                    const enumStructIssue = validateEnumStructInitializer(nested, dimSpecs[dimIndex + 1] || null);
                    if (enumStructIssue) return enumStructIssue;
                    const leafIssue = validateLeafArrayValue(nested, dimSpecs[dimIndex + 1] || null, partRangeStart);
                    if (leafIssue) return leafIssue;
                    continue;
                }
                if (!nested.startsWith('{')) {
                    return readLeadingInitializerTokenIssue(nested, partRangeStart, escapeChar);
                }
                const nestedIssue = checkRecursive(nested, dimIndex + 1, partRangeStart);
                if (nestedIssue) return nestedIssue;
            }
            return null;
        };

        if (dimSpecs.length === 1 && valueText.startsWith('"')) {
            const measured = measurePawnStringLiteral(valueText, escapeChar);
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

    function findInitializerIssueSourceOffset(source, valueStartOffset, issue, escapeChar = '') {
        const sourceText = String(source || '');
        const target = String(issue?.token || '');
        if (!sourceText || !target || valueStartOffset < 0) return -1;

        let inString = false;
        let stringChar = '';
        let lineComment = false;
        let blockComment = false;
        let braceDepth = 0;
        let sawBrace = false;
        const isIdentifierChar = char => /[A-Za-z0-9_@]/.test(char || '');

        for (let offset = valueStartOffset; offset < sourceText.length; offset++) {
            const char = sourceText[offset];
            const next = sourceText[offset + 1] || '';
            if (blockComment) {
                if (char === '*' && next === '/') {
                    blockComment = false;
                    offset++;
                }
                continue;
            }
            if (lineComment) {
                if (char === '\n') lineComment = false;
                continue;
            }
            if (inString) {
                if (char === stringChar && !isEscapedQuote(sourceText, offset, escapeChar)) {
                    inString = false;
                }
                continue;
            }
            if (char === '/' && next === '/') {
                lineComment = true;
                offset++;
                continue;
            }
            if (char === '/' && next === '*') {
                blockComment = true;
                offset++;
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                continue;
            }
            if (char === '{') {
                braceDepth++;
                sawBrace = true;
                continue;
            }
            if (char === '}') {
                if (braceDepth > 0) braceDepth--;
                if (sawBrace && braceDepth === 0) {
                    if (sourceText.startsWith(target, offset)) return offset;
                    break;
                }
                continue;
            }
            if (!sourceText.startsWith(target, offset)) continue;
            const before = sourceText[offset - 1] || '';
            const after = sourceText[offset + target.length] || '';
            if (isIdentifierChar(target[0]) && (isIdentifierChar(before) || isIdentifierChar(after))) {
                continue;
            }
            if (/^[0-9.]/.test(target) && /[A-Za-z0-9_.]/.test(before + after)) {
                continue;
            }
            return offset;
        }
        return -1;
    }

    return {
        isOpenMultilineBraceInitializerLine,
        isOpenMultilineBraceInitializerForCurrentDecl,
        resolveConstantStringLiteralExpression,
        isKnownConstantInitializerExpression,
        explainArrayInitializerIssue,
        findInvalidArraySizeIssue,
        findInitializerIssueSourceOffset
    };
}

module.exports = { createInitializerDiagnostics };
