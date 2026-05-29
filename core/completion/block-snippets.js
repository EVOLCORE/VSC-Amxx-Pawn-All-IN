function normalizeBlockBraceStyle(value) {
    return String(value || '').trim().toLowerCase() === 'next-line'
        ? 'next-line'
        : 'same-line';
}

function buildBlockSnippet(header, options = {}) {
    const style = normalizeBlockBraceStyle(options.braceStyle);
    const body = options.body == null ? '\t$0' : String(options.body);
    const text = String(header || '').trimEnd();
    return style === 'next-line'
        ? `${text}\n{\n${body}\n}`
        : `${text} {\n${body}\n}`;
}

function buildDoWhileSnippet(condition = '${1:condition}', options = {}) {
    const style = normalizeBlockBraceStyle(options.braceStyle);
    const body = options.body == null ? '\t$0' : String(options.body);
    return style === 'next-line'
        ? `do\n{\n${body}\n} while (${condition});`
        : `do {\n${body}\n} while (${condition});`;
}

function buildSwitchSnippet(options = {}) {
    const style = normalizeBlockBraceStyle(options.braceStyle);
    return style === 'next-line'
        ? 'switch (${1:value})\n{\n\tcase ${2:0}:\n\t{\n\t\t$0\n\t}\n}'
        : 'switch (${1:value}) {\n\tcase ${2:0}: {\n\t\t$0\n\t}\n}';
}

module.exports = {
    normalizeBlockBraceStyle,
    buildBlockSnippet,
    buildDoWhileSnippet,
    buildSwitchSnippet
};
