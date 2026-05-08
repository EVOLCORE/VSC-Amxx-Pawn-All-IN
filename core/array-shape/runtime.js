function createArrayShapeCore(deps = {}) {
    const {
        measurePawnStringLiteral,
        parseBraceArrayLiteralExpression,
        parseDimsParts,
        parseDimSpec
    } = deps;

    const normalizeOptions = options =>
        typeof options === 'string'
            ? { escapeChar: options }
            : { ...(options || {}) };

    function countDims(dims) {
        return (String(dims || '').match(/\[/g) || []).length;
    }

    function getDimParts(dimsText) {
        if (typeof parseDimsParts === 'function') {
            return parseDimsParts(dimsText);
        }
        return String(dimsText || '')
            .match(/\[[^\]]*\]/g)?.map(dim => dim.slice(1, -1).trim()) || [];
    }

    function parseBraceInitializer(value, options = {}) {
        const opts = normalizeOptions(options);
        const source = String(value || '').trim();
        if (!source || typeof parseBraceArrayLiteralExpression !== 'function') return null;
        const parts = parseBraceArrayLiteralExpression(source, opts.escapeChar);
        return Array.isArray(parts) ? parts : null;
    }

    function getInitializerCellSize(value, options = {}) {
        const opts = normalizeOptions(options);
        const source = String(value || '').trim();
        if (!source) return 0;

        const measured = measurePawnStringLiteral?.(source, opts.escapeChar);
        if (measured?.bytesWithTerminator != null) {
            return measured.bytesWithTerminator;
        }

        const parts = parseBraceInitializer(source, opts);
        if (parts) {
            return parts.reduce((total, part) => total + getInitializerCellSize(part, opts), 0);
        }

        return 1;
    }

    function inferDisplayInitializerShape(value, remainingDims, options = {}) {
        const opts = normalizeOptions(options);
        if (!Number.isInteger(remainingDims) || remainingDims <= 0) return [];
        const source = String(value || '').trim();
        if (!source) return [];

        if (remainingDims === 1) {
            return [getInitializerCellSize(source, opts)];
        }

        const parts = parseBraceInitializer(source, opts);
        if (!parts) return [];

        const childShapes = parts
            .map(part => inferDisplayInitializerShape(part, remainingDims - 1, opts))
            .filter(shape => shape.length);
        const merged = [];
        for (const shape of childShapes) {
            for (let index = 0; index < shape.length; index++) {
                merged[index] = Math.max(merged[index] || 0, shape[index] || 0);
            }
        }
        return [parts.length, ...merged];
    }

    function resolveKnownDimPart(part, options = {}) {
        const opts = normalizeOptions(options);
        const source = String(part || '').trim();
        if (!source) return null;
        if (/^-?\d+$/.test(source)) return Number.parseInt(source, 10);

        const normalized = source.replace(/^_?\s*:\s*/, '').trim();
        const getDeclSize = decl => {
            const value = Number.parseInt(String(decl?.value || ''), 10);
            return Number.isInteger(value) ? value : null;
        };
        const lookup = opts.lookup || null;
        const lookupDecl = lookup?.findAnyDeclByName?.(source, decl =>
            decl?.type === 'enum' ||
            decl?.type === 'enum-item' ||
            decl?.type === 'define' ||
            String(decl?.name || '').replace(/^_?\s*:\s*/, '').trim() === normalized ||
            String(decl?.enumDisplayName || '').replace(/^_?\s*:\s*/, '').trim() === normalized
        ) || null;
        const lookupSize = getDeclSize(lookupDecl);
        if (lookupSize != null) return lookupSize;

        const allDecls = Array.isArray(opts.allDecls) ? opts.allDecls : [];
        const enumDecl = allDecls.find(decl =>
            decl?.type === 'enum' &&
            (
                decl.name === source ||
                decl.enumDisplayName === source ||
                String(decl.name || '').replace(/^_?\s*:\s*/, '').trim() === normalized ||
                String(decl.enumDisplayName || '').replace(/^_?\s*:\s*/, '').trim() === normalized
            )
        );
        const enumSize = getDeclSize(enumDecl);
        if (enumSize != null) return enumSize;

        const constDecl = allDecls.find(decl =>
            (decl?.type === 'define' || decl?.type === 'enum-item' || decl?.type === 'enum') &&
            decl.name === source
        );
        const constValue = getDeclSize(constDecl);
        if (constValue != null) return constValue;

        if (typeof parseDimSpec === 'function') {
            const dimSpec = parseDimSpec(source, allDecls, new Set(), opts.analysisCache || null);
            if (dimSpec?.capacity != null) return dimSpec.capacity;
        }

        return null;
    }

    function getInitializerDisplayShape(dimsText, value, options = {}) {
        const opts = normalizeOptions(options);
        const dimParts = getDimParts(dimsText);
        if (!dimParts.length) return [];

        const inferredShape = inferDisplayInitializerShape(value, dimParts.length, opts);
        const result = [];
        for (let index = 0; index < dimParts.length; index++) {
            const known = resolveKnownDimPart(dimParts[index], opts);
            if (known != null) {
                result.push(known);
                continue;
            }
            const inferred = inferredShape[index];
            if (Number.isInteger(inferred) && inferred >= 0) {
                result.push(inferred);
            }
        }
        return result;
    }

    function inferEffectiveDimPartsFromValue(baseDimParts, value, options = {}) {
        const opts = normalizeOptions(options);
        const resolved = [...(Array.isArray(baseDimParts) ? baseDimParts : [])];
        if (!resolved.length || !resolved.some(part => part === '')) return resolved;

        const topLevelSource = String(value || '').trim();
        if (resolved.length === 1 && resolved[0] === '' && topLevelSource.startsWith('"')) {
            const measure = measurePawnStringLiteral?.(topLevelSource, opts.escapeChar);
            if (measure?.bytesWithTerminator != null) {
                resolved[0] = String(measure.bytesWithTerminator);
            }
            return resolved;
        }

        const setInferredCapacity = (dimIndex, capacity) => {
            if (baseDimParts[dimIndex] !== '') return;
            const numericCapacity = Number(capacity);
            if (!Number.isFinite(numericCapacity) || numericCapacity < 0) return;
            const currentCapacity = Number(resolved[dimIndex]);
            if (!resolved[dimIndex] || !Number.isFinite(currentCapacity) || numericCapacity > currentCapacity) {
                resolved[dimIndex] = String(numericCapacity);
            }
        };

        const inferRecursive = (expr, dimIndex) => {
            if (dimIndex >= resolved.length) return [];

            const source = String(expr || '').trim();
            if (source.startsWith('"')) {
                const measure = measurePawnStringLiteral?.(source, opts.escapeChar);
                if (measure?.bytesWithTerminator != null) {
                    setInferredCapacity(dimIndex, measure.bytesWithTerminator);
                }
                return resolved.slice(dimIndex);
            }

            const braceParts = parseBraceInitializer(source, opts);
            if (!braceParts) return [];

            setInferredCapacity(dimIndex, braceParts.length);

            if (dimIndex + 1 < resolved.length && braceParts.length) {
                for (const part of braceParts) {
                    inferRecursive(part, dimIndex + 1);
                }
            }

            return resolved.slice(dimIndex);
        };

        inferRecursive(value, 0);
        return resolved;
    }

    return {
        countDims,
        getInitializerCellSize,
        inferDisplayInitializerShape,
        resolveKnownDimPart,
        getInitializerDisplayShape,
        inferEffectiveDimPartsFromValue
    };
}

module.exports = { createArrayShapeCore };
