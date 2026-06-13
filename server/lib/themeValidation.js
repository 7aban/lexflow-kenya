const HEX_COLOR_REGEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
// Keys accepted for validation but silently dropped from output (frontend
// convenience keys that should never be persisted as theme values).
const DROP_KEYS = new Set(['id', 'theme']);
const ALLOWED_THEME_KEYS = new Set([
  'primaryColor', 'accentColor', 'backgroundColor', 'surfaceColor',
  'textColor', 'textSecondaryColor', 'sidebarColor', 'sidebarTextColor',
  'buttonColor', 'buttonTextColor', 'borderColor', 'linkColor',
  'onPrimaryColor', 'onAccentColor', 'onSidebarColor', 'onHeaderColor',
  'onButtonColor', 'cardTextColor', 'cardMutedColor',
  'successColor', 'warningColor', 'errorColor', 'infoColor',
  'headerColor', 'headerTextColor', 'footerColor', 'footerTextColor',
  'cardColor', 'cardBorderColor', 'inputBorderColor', 'inputFocusBorderColor',
  'navColor', 'navTextColor', 'navActiveColor', 'navActiveTextColor',
  'badgePrimaryColor', 'badgePrimaryTextColor',
  'fontFamily', 'headingFontFamily', 'fontSizeBase', 'fontWeightBase',
  'borderRadius', 'spacingUnit',
  'logo', 'logoDark', 'logoLight', 'favicon',
  'source',
]);
const SOURCE_ENUM = Object.freeze(['default', 'manual', 'preset', 'logo_extracted']);
const MAX_THEME_JSON_LENGTH = 2000;
const MIN_CONTRAST_RATIO = 3.0;
const WCAG_AA_CONTRAST_RATIO = 4.5;

const PRESETS = Object.freeze({
  'lexflow-default': {
    source: 'preset',
    primaryColor: '#0F1B33',
    accentColor: '#D4A34A',
    backgroundColor: '#0A0F1A',
    surfaceColor: '#111827',
    textColor: '#E5E7EB',
    textSecondaryColor: '#9CA3AF',
    sidebarColor: '#0F1B33',
    sidebarTextColor: '#E5E7EB',
    buttonColor: '#D4A34A',
    buttonTextColor: '#0F1B33',
    borderColor: '#1F2937',
    linkColor: '#D4A34A',
    headerColor: '#0F1B33',
    headerTextColor: '#E5E7EB',
    footerColor: '#0A0F1A',
    footerTextColor: '#9CA3AF',
    cardColor: '#111827',
    cardBorderColor: '#1F2937',
  },
  'emerald-gold': {
    source: 'preset',
    primaryColor: '#1B4332',
    accentColor: '#C9A227',
    backgroundColor: '#0D1F17',
    surfaceColor: '#142B1F',
    textColor: '#E8E6DF',
    textSecondaryColor: '#A8A49A',
    sidebarColor: '#1B4332',
    sidebarTextColor: '#E8E6DF',
    buttonColor: '#C9A227',
    buttonTextColor: '#1B4332',
    borderColor: '#2D5A43',
    linkColor: '#C9A227',
    headerColor: '#1B4332',
    headerTextColor: '#E8E6DF',
    footerColor: '#0D1F17',
    footerTextColor: '#A8A49A',
    cardColor: '#142B1F',
    cardBorderColor: '#2D5A43',
  },
  'midnight-slate': {
    source: 'preset',
    primaryColor: '#1E293B',
    accentColor: '#818CF8',
    backgroundColor: '#0F172A',
    surfaceColor: '#1E293B',
    textColor: '#F1F5F9',
    textSecondaryColor: '#94A3B8',
    sidebarColor: '#0F172A',
    sidebarTextColor: '#F1F5F9',
    buttonColor: '#818CF8',
    buttonTextColor: '#0F172A',
    borderColor: '#334155',
    linkColor: '#818CF8',
    headerColor: '#1E293B',
    headerTextColor: '#F1F5F9',
    footerColor: '#0F172A',
    footerTextColor: '#94A3B8',
    cardColor: '#1E293B',
    cardBorderColor: '#334155',
  },
});

function normalizeHexColor(value) {
  if (typeof value !== 'string' || !HEX_COLOR_REGEX.test(value.trim())) {
    return null;
  }
  let hex = value.trim().toUpperCase();
  if (hex.length === 4) {
    hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return hex;
}

function hexToRgb(hex) {
  const bigint = parseInt(hex.slice(1), 16);
  return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
}

function relativeLuminance({ r, g, b }) {
  const [rs, gs, bs] = [r, g, b].map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(hex1, hex2) {
  const normalized1 = normalizeHexColor(hex1);
  const normalized2 = normalizeHexColor(hex2);
  if (!normalized1 || !normalized2) return 0;
  const l1 = relativeLuminance(hexToRgb(normalized1));
  const l2 = relativeLuminance(hexToRgb(normalized2));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function readableTextColor(background, preferred) {
  const bg = normalizeHexColor(background);
  const preferredColor = normalizeHexColor(preferred);
  if (!bg) return preferredColor || '#101827';
  if (preferredColor && contrastRatio(preferredColor, bg) >= MIN_CONTRAST_RATIO) {
    return preferredColor;
  }
  return contrastRatio('#FFFFFF', bg) >= contrastRatio('#101827', bg) ? '#FFFFFF' : '#101827';
}

function resolveReadableTheme(input = {}) {
  const primaryColor = input.primaryColor || '#0F1B33';
  const accentColor = input.accentColor || '#D4A34A';
  const backgroundColor = input.backgroundColor || '#F5F7FA';
  const cardColor = input.cardColor || input.surfaceColor || '#FFFFFF';
  const headerColor = input.headerColor || primaryColor;
  const sidebarColor = input.sidebarColor || primaryColor;
  const buttonColor = input.buttonColor || accentColor;
  const onSidebarColor = readableTextColor(sidebarColor, input.onSidebarColor || input.sidebarTextColor || '#FFFFFF');
  const onButtonColor = readableTextColor(buttonColor, input.onButtonColor || input.buttonTextColor || '#FFFFFF');
  const onHeaderColor = readableTextColor(headerColor, input.onHeaderColor || input.headerTextColor || '#FFFFFF');

  return {
    ...input,
    primaryColor,
    accentColor,
    backgroundColor,
    surfaceColor: input.surfaceColor || cardColor,
    cardColor,
    headerColor,
    sidebarColor,
    buttonColor,
    textColor: readableTextColor(backgroundColor, input.textColor || '#101827'),
    textSecondaryColor: readableTextColor(backgroundColor, input.textSecondaryColor || '#697386'),
    cardTextColor: readableTextColor(cardColor, input.cardTextColor || input.textColor || '#101827'),
    cardMutedColor: readableTextColor(cardColor, input.cardMutedColor || input.textSecondaryColor || '#697386'),
    onPrimaryColor: readableTextColor(primaryColor, input.onPrimaryColor || '#FFFFFF'),
    onAccentColor: readableTextColor(accentColor, input.onAccentColor || '#101827'),
    onSidebarColor,
    onHeaderColor,
    onButtonColor,
    sidebarTextColor: onSidebarColor,
    buttonTextColor: onButtonColor,
    headerTextColor: onHeaderColor,
    source: input.source || 'default',
  };
}

function validateColorValue(value, key) {
  const normalized = normalizeHexColor(value);
  if (!normalized) {
    return { error: `Invalid color for ${key}: only #RGB or #RRGGBB hex allowed` };
  }
  return { value: normalized };
}

function validateThemeInput(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'Theme must be a JSON object' };
  }
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (DROP_KEYS.has(key)) continue;
    if (!ALLOWED_THEME_KEYS.has(key)) {
      return { error: `Unknown theme key: ${key}` };
    }
    if (key === 'source') {
      if (!SOURCE_ENUM.includes(value)) {
        return { error: `Invalid source: ${value}. Must be one of: ${SOURCE_ENUM.join(', ')}` };
      }
      result[key] = value;
      continue;
    }
    if (key === 'logo' || key === 'logoDark' || key === 'logoLight' || key === 'favicon') {
      if (typeof value !== 'string') {
        return { error: `${key} must be a string URL or data URI` };
      }
      if (value.length > 5000) {
        return { error: `${key} exceeds 5000 character limit` };
      }
      result[key] = value;
      continue;
    }
    if (key === 'fontFamily' || key === 'headingFontFamily') {
      if (typeof value !== 'string' || value.length > 200) {
        return { error: `${key} must be a string under 200 characters` };
      }
      result[key] = value;
      continue;
    }
    if (key === 'fontSizeBase' || key === 'fontWeightBase' || key === 'borderRadius' || key === 'spacingUnit') {
      if (typeof value !== 'string' || !/^[\d.]+(px|rem|em|%|vw|vh|pt)?$/.test(value)) {
        return { error: `${key} must be a valid CSS size value` };
      }
      result[key] = value;
      continue;
    }
    const colorResult = validateColorValue(value, key);
    if (colorResult.error) {
      return colorResult;
    }
    result[key] = colorResult.value;
  }
  const rawJson = JSON.stringify(result);
  if (rawJson.length > MAX_THEME_JSON_LENGTH) {
    return { error: `Theme JSON exceeds ${MAX_THEME_JSON_LENGTH} character limit` };
  }
  return { value: result };
}

function checkContrastPairs(theme, pairs) {
  const warnings = [];
  const blocks = [];
  for (const { fg, bg, label } of pairs) {
    if (theme[fg] && theme[bg]) {
      const ratio = contrastRatio(theme[fg], theme[bg]);
      if (ratio < MIN_CONTRAST_RATIO) {
        blocks.push(`${label} contrast ratio ${ratio.toFixed(2)}:1 is below minimum ${MIN_CONTRAST_RATIO}:1`);
      } else if (ratio < WCAG_AA_CONTRAST_RATIO) {
        warnings.push(`${label} contrast ratio ${ratio.toFixed(2)}:1 is below WCAG AA ${WCAG_AA_CONTRAST_RATIO}:1`);
      }
    }
  }
  return { warnings, blocks };
}

function getDefaultContrastPairs(theme) {
  return [
    { fg: 'textColor', bg: 'backgroundColor', label: 'Text/Background' },
    { fg: 'textSecondaryColor', bg: 'backgroundColor', label: 'Secondary Text/Background' },
    { fg: 'buttonTextColor', bg: 'buttonColor', label: 'Button Text/Button' },
    { fg: 'sidebarTextColor', bg: 'sidebarColor', label: 'Sidebar Text/Sidebar' },
    { fg: 'headerTextColor', bg: 'headerColor', label: 'Header Text/Header' },
    { fg: 'cardTextColor', bg: 'cardColor', label: 'Card Text/Card' },
    { fg: 'cardMutedColor', bg: 'cardColor', label: 'Card Muted Text/Card' },
    { fg: 'onPrimaryColor', bg: 'primaryColor', label: 'Primary Text/Primary' },
    { fg: 'onAccentColor', bg: 'accentColor', label: 'Accent Text/Accent' },
    { fg: 'onSidebarColor', bg: 'sidebarColor', label: 'Sidebar On Color/Sidebar' },
    { fg: 'onHeaderColor', bg: 'headerColor', label: 'Header On Color/Header' },
    { fg: 'onButtonColor', bg: 'buttonColor', label: 'Button On Color/Button' },
    { fg: 'footerTextColor', bg: 'footerColor', label: 'Footer Text/Footer' },
    { fg: 'navActiveTextColor', bg: 'navActiveColor', label: 'Nav Active Text/Nav Active' },
    { fg: 'navTextColor', bg: 'navColor', label: 'Nav Text/Nav' },
    { fg: 'badgePrimaryTextColor', bg: 'badgePrimaryColor', label: 'Badge Text/Badge' },
  ].filter(pair => theme[pair.fg] && theme[pair.bg]);
}

function validateThemeAccessibility(theme) {
  const pairs = getDefaultContrastPairs(theme);
  return checkContrastPairs(theme, pairs);
}

function getPresets() {
  return Object.entries(PRESETS).map(([id, theme]) => ({ id, ...theme }));
}

function getThemeById(id) {
  const theme = PRESETS[id];
  if (!theme) return null;
  return { id, ...theme };
}

module.exports = {
  ALLOWED_THEME_KEYS,
  SOURCE_ENUM,
  MAX_THEME_JSON_LENGTH,
  MIN_CONTRAST_RATIO,
  WCAG_AA_CONTRAST_RATIO,
  PRESETS,
  normalizeHexColor,
  hexToRgb,
  relativeLuminance,
  contrastRatio,
  readableTextColor,
  resolveReadableTheme,
  validateColorValue,
  validateThemeInput,
  checkContrastPairs,
  getDefaultContrastPairs,
  validateThemeAccessibility,
  getPresets,
  getThemeById,
};
