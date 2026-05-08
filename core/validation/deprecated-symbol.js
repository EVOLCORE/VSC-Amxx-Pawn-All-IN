function createDeprecatedSymbolPolicy() {
    function getDeprecatedSymbolIssue(decl) {
        if (!decl || decl.deprecated !== true) return null;
        return {
            kind: 'deprecatedSymbol',
            messageKey: 'validation.symbolDeprecated',
            params: {
                name: String(decl.name || ''),
                message: String(decl.deprecatedMessage || '')
            },
            severity: 'warning'
        };
    }

    return { getDeprecatedSymbolIssue };
}

module.exports = { createDeprecatedSymbolPolicy };
