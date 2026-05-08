const AMXX_RECOMMENDED_THEME_OPTIONS = Object.freeze([
    {
        label: 'AmxxPawnAllIn Olive',
        descriptionKey: 'theme.option.olive.description'
    },
    {
        label: 'AmxxPawnAllIn Dark',
        descriptionKey: 'theme.option.dark.description'
    },
    {
        label: 'AmxxPawnAllIn Light',
        descriptionKey: 'theme.option.light.description'
    },
    {
        label: 'AmxxPawnAllIn Graphite',
        descriptionKey: 'theme.option.graphite.description'
    },
    {
        label: 'AmxxPawnAllIn Aurora',
        descriptionKey: 'theme.option.aurora.description'
    }
]);

function createThemeRecommendationFeature(deps) {
    const {
        vscode,
        t,
        isPawnDocument,
        shouldShowThemeRecommendation
    } = deps;

    let themeRecommendationMessageVisible = false;
    let themeRecommendationCooldownUntil = 0;
    const THEME_RECOMMENDATION_COOLDOWN_MS = 3 * 60 * 1000;

    const isRecommendedAmxxTheme = themeName =>
        AMXX_RECOMMENDED_THEME_OPTIONS.some(theme => theme.label === String(themeName || '').trim());

    const getCurrentColorTheme = () =>
        vscode.workspace
            .getConfiguration('workbench')
            .get('colorTheme', '');

    async function prompt(editor) {
        if (!isPawnDocument(editor?.document)) return;
        if (!shouldShowThemeRecommendation()) return;
        if (themeRecommendationMessageVisible) return;
        if (Date.now() < themeRecommendationCooldownUntil) return;
        if (isRecommendedAmxxTheme(getCurrentColorTheme())) return;

        themeRecommendationMessageVisible = true;
        themeRecommendationCooldownUntil = Date.now() + THEME_RECOMMENDATION_COOLDOWN_MS;
        try {
            const action = await vscode.window.showInformationMessage(
                t('theme.recommendation.message'),
                t('theme.recommendation.chooseTheme'),
                t('theme.recommendation.disableHint')
            );
            if (action === t('theme.recommendation.chooseTheme')) {
                const selectedTheme = await vscode.window.showQuickPick(
                    AMXX_RECOMMENDED_THEME_OPTIONS.map(theme => ({
                        label: theme.label,
                        description: t(theme.descriptionKey)
                    })),
                    {
                        placeHolder: t('theme.recommendation.quickPickPlaceholder')
                    }
                );
                if (selectedTheme?.label) {
                    await vscode.workspace
                        .getConfiguration('workbench')
                        .update('colorTheme', selectedTheme.label, vscode.ConfigurationTarget.Global);
                }
            } else if (action === t('theme.recommendation.disableHint')) {
                await vscode.workspace
                    .getConfiguration('amxxPawnAllIn')
                    .update('showThemeRecommendation', false, vscode.ConfigurationTarget.Global);
            }
        } finally {
            themeRecommendationMessageVisible = false;
        }
    }

    return {
        prompt
    };
}

module.exports = { createThemeRecommendationFeature };
