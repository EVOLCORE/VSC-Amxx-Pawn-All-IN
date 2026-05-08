// Shared enum-shape helpers used by validation and hover-specific enum access.
function createEnumCore(deps = {}) {
    const {
        parseDimsParts,
        evaluatePawnNumericExpr
    } = deps;

    function extractEnumSymbolName(dimPart) {
        const trimmed = String(dimPart || '').trim();
        if (!trimmed || /^\d+$/.test(trimmed)) return '';
        const match = trimmed.match(/^(?:(?:[A-Za-z_@]\w*|_)\s*:\s*)?([A-Za-z_@]\w*)$/);
        return match ? match[1] : '';
    }

    function isPowerOfTwo(value) {
        return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
    }

    function formatResolvedEnumValueDisplay(rawValue, resolvedValue) {
        const raw = String(rawValue || '').trim();
        const resolved = String(resolvedValue || '').trim();
        if (!raw) return resolved;
        if (!resolved || raw === resolved) return raw;
        return `${raw} [${resolved}]`;
    }

    function formatAutoEnumValueDisplay(value, stepSpec, decls = []) {
        const numericValue = Number(value);
        if (!stepSpec || !Number.isFinite(numericValue)) return String(value);

        const stepValue = evaluatePawnNumericExpr(stepSpec.expr, decls);
        if (stepSpec.op === '<<' && stepValue === 1 && isPowerOfTwo(numericValue)) {
            return `(1<<${Math.log2(numericValue)}) [${numericValue}]`;
        }
        if (stepSpec.op === '>>' && stepValue === 1 && isPowerOfTwo(numericValue)) {
            return `(1<<${Math.log2(numericValue)}) [${numericValue}]`;
        }

        return String(value);
    }

    function getEnumDeclsForVariableDims(data, allDecls = [], lookup = null) {
        if (data?.type !== 'variable' || !data.dims) return [];

        const result = [];
        const seen = new Set();
        for (const dimPart of parseDimsParts(data.dims)) {
            const enumName = extractEnumSymbolName(dimPart);
            if (!enumName || seen.has(enumName)) continue;
            const enumDecl = lookup?.findAnyDeclByName
                ? lookup.findAnyDeclByName(enumName, item => item.type === 'enum')
                : allDecls.find(item => item.type === 'enum' && item.name === enumName);
            if (!enumDecl) continue;
            seen.add(enumName);
            result.push(enumDecl);
        }
        return result;
    }

    return {
        extractEnumSymbolName,
        formatResolvedEnumValueDisplay,
        formatAutoEnumValueDisplay,
        getEnumDeclsForVariableDims
    };
}

module.exports = { createEnumCore };
