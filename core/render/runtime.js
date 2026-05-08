const { createArrayShapeCore } = require('../array-shape');

// Shared declaration/signature rendering helpers used by hover and completion.
function createRenderCore(deps) {
    const {
        measurePawnStringLiteral,
        parseBraceArrayLiteralExpression,
        parseDimsParts,
        parseDimSpec
    } = deps;
    const arrayShapeCore = createArrayShapeCore({
        measurePawnStringLiteral,
        parseBraceArrayLiteralExpression,
        parseDimsParts,
        parseDimSpec
    });

    function getEnumItemValueText(data) {
        return data.valueDisplay || data.value || '';
    }

    function shouldRenderVariableInitializer(data, value) {
        const source = String(value || '').trim();
        if (!source) return false;
        const dimCount = arrayShapeCore.countDims(data?.dims || '');
        if (dimCount) return false;
        return /^"(?:[^"\\]|\\.)*"$/.test(source) ||
            /^'(?:[^'\\]|\\.)*'$/.test(source) ||
            /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(source) ||
            /^(?:true|false|cellmin|cellmax)$/i.test(source);
    }

    function getVariableInitializerText(data, options = {}) {
        const value = String(data?.value || '').trim();
        if (shouldRenderVariableInitializer(data, value)) return ` = ${value}`;
        const dimCount = arrayShapeCore.countDims(data?.dims || '');
        if (dimCount > 0 && value) {
            const shape = arrayShapeCore.getInitializerDisplayShape(data.dims || '', value, options)
                .filter(size => Number.isInteger(size) && size >= 0);
            if (shape.length) return ` size(${shape.join(', ')})`;
        }
        return '';
    }

    function buildSig(data, options = {}) {
        const tag = data.typeTag ? `${data.typeTag}:` : '';
        const mods = (data.modifiers || []).join(' ');
        const pre = mods ? mods + ' ' : '';
        const displayName = data.hoverDisplayName || data.name;
        const leadingDims = data.type !== 'variable' ? (data.dims || '') : '';
        if (data.type === 'define') {
            return data.macroStyle === 'paren'
                ? `#define ${displayName}(${data.args}) ${data.value}`
                : data.macroStyle === 'bracket'
                    ? `#define ${displayName}[${data.macroIndexer || ''}] ${data.value}`
                    : `#define ${displayName} ${data.value}`;
        }
        if (data.type === 'builtin') {
            return data.args
                ? `${displayName}(${data.args})`
                : `${tag}${displayName}${data.value ? ` = ${data.value}` : ''}`;
        }
        if (data.type === 'enum') {
            const enumDisplay = data.enumDisplayName || data.name;
            return enumDisplay
                ? `enum ${enumDisplay}${data.value ? ` (size ${data.value})` : ''}`
                : `enum${data.value ? ` (size ${data.value})` : ''}`;
        }
        if (data.type === 'enum-item') {
            const enumScope = data.enumName ? ` of ${data.enumName}` : '';
            const valueText = getEnumItemValueText(data);
            return `enum part ${tag}${displayName}${data.dims || ''}${valueText ? ' = ' + valueText : ''}${enumScope}`;
        }
        if (data.type === 'variable') {
            const dims = data.hoverDisplayName ? '' : (data.dims || '');
            return `${pre}${tag}${displayName}${dims}${getVariableInitializerText(data, options)}`;
        }
        return `${pre}${tag}${leadingDims}${displayName}(${data.args || ''})`;
    }

    function buildEnumMemberLine(member) {
        const memberTag = member.typeTag ? `${member.typeTag}:` : '';
        const memberDims = member.dims || '';
        const memberValue = getEnumItemValueText(member);
        return `${memberTag}${member.name}${memberDims}${memberValue ? ` = ${memberValue}` : ''}`;
    }

    return {
        getEnumItemValueText,
        buildEnumMemberLine,
        buildSig
    };
}

module.exports = { createRenderCore };
