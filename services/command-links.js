function createCommandLinkService(deps) {
    const {
        t,
        isHoverGoToDefinitionLinksEnabled
    } = deps;

    function buildCommandLink(label, filePath, lineNumber) {
        if (!isHoverGoToDefinitionLinksEnabled() || !filePath) return '';
        const args = encodeURIComponent(JSON.stringify([filePath, lineNumber]));
        const safeLabel = String(label || t('hover.goToDefinition')).replace(/[\[\]]/g, '\\$&');
        return `[${safeLabel}](command:amxxPawnAllIn.goToLocation?${args})`;
    }

    return {
        buildCommandLink
    };
}

module.exports = { createCommandLinkService };
