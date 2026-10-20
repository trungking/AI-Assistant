import styleText from '../index.css?inline';

/**
 * CSS fixes for rendering the app inside a Shadow DOM on arbitrary host pages.
 *
 * 1. KaTeX fonts: Chrome ignores @font-face inside shadow roots, and the
 *    relative font URLs would resolve against the host page anyway. We strip
 *    KaTeX @font-face rules from the shadow CSS and inject them once into the
 *    host document with absolute chrome-extension:// URLs. Families are renamed
 *    so they never collide with a host page that ships its own KaTeX fonts.
 *    The fonts must be listed in web_accessible_resources (lib/katex/fonts/*);
 *    until then the loads are denied and KaTeX falls back to system fonts.
 *
 * 2. Tailwind v4 relies on @property initial values for --tw-* variables, but
 *    Chrome ignores @property in shadow roots. We derive the initial values
 *    from the emitted @property rules and set them explicitly, mirroring
 *    Tailwind's own fallback for browsers without @property support.
 */

const KATEX_FAMILY_PREFIX = 'ai-ask-';
const KATEX_FONT_STYLE_ID = 'ai-ask-katex-fonts';
const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/g;
const KATEX_FONT_URL_RE = /url\(\s*(['"]?)[^'")]*?(KaTeX_[\w-]+\.(?:woff2|woff|ttf))\1\s*\)/g;
// KaTeX family names appear as `font-family:KaTeX_X`, `"KaTeX_X"` or in the
// `font:` shorthand; file names in URLs are always preceded by `/`.
const KATEX_FAMILY_RE = /(^|[^/\w-])KaTeX_/g;

const renameKatexFamilies = (css: string) => css.replace(KATEX_FAMILY_RE, `$1${KATEX_FAMILY_PREFIX}KaTeX_`);

const buildTailwindPropertyFallback = (css: string): string => {
    const declarations: string[] = [];
    const seen = new Set<string>();
    const propertyRe = /@property\s+(--tw-[\w-]+)\s*\{([^}]*)\}/g;
    for (const match of css.matchAll(propertyRe)) {
        const [, name, body] = match;
        if (seen.has(name)) continue;
        seen.add(name);
        const syntax = /syntax\s*:\s*(['"])(.*?)\1/.exec(body)?.[2];
        let value = /initial-value\s*:\s*([^;]+)/.exec(body)?.[1].trim() ?? 'initial';
        // Unitless 0 is not a valid <length> inside calc() once untyped.
        if (syntax === '<length>' && value === '0') value = '0px';
        declarations.push(`${name}:${value}`);
    }
    if (declarations.length === 0) return '';
    // Same (lowest) layer Tailwind uses, so utilities always override it.
    return `@layer properties{:host,*,::before,::after,::backdrop{${declarations.join(';')}}}`;
};

let cached: { shadowCss: string; fontFaceCss: string } | null = null;

const getProcessedStyles = () => {
    if (cached) return cached;
    const fontFaces: string[] = [];
    const withoutKatexFonts = styleText.replace(FONT_FACE_RE, rule => {
        if (!rule.includes('KaTeX_')) return rule;
        fontFaces.push(rule);
        return '';
    });
    const fontFaceCss = renameKatexFamilies(
        fontFaces.join('\n').replace(KATEX_FONT_URL_RE, (_m, _q, file: string) =>
            `url("${chrome.runtime.getURL(`lib/katex/fonts/${file}`)}")`
        )
    );
    const shadowCss = buildTailwindPropertyFallback(styleText) + '\n' + renameKatexFamilies(withoutKatexFonts);
    cached = { shadowCss, fontFaceCss };
    return cached;
};

/** CSS to inject into the content popup's shadow root. */
export const getShadowCss = (): string => getProcessedStyles().shadowCss;

/** Inject KaTeX @font-face rules into the host document once. */
export const ensureKatexFontsInDocument = (): void => {
    if (document.getElementById(KATEX_FONT_STYLE_ID)) return;
    const { fontFaceCss } = getProcessedStyles();
    if (!fontFaceCss) return;
    const style = document.createElement('style');
    style.id = KATEX_FONT_STYLE_ID;
    style.textContent = fontFaceCss;
    (document.head || document.documentElement).appendChild(style);
};
