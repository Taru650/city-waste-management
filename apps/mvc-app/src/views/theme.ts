import type { ThemeConfig } from 'antd';

/**
 * Design tokens for the officials' portal: navy for structure (authority), royal blue for actions,
 * teal as the accent, and green / amber / red reserved for status. Text colours meet WCAG AA on
 * their backgrounds. Mirrored as CSS variables in app/globals.css (keep the two in step).
 */
export const colors = {
  navy: '#0b2545',
  navyLight: '#13315c',
  royal: '#1d4ed8',
  royalSoft: '#e8efff',
  teal: '#0f8b8d',
  tealSoft: '#e3f4f4',
  success: '#15803d',
  successSoft: '#e7f6ec',
  warning: '#b45309', // amber, dark enough for text on white
  warningFill: '#f59e0b',
  warningSoft: '#fef3e2',
  danger: '#b91c1c',
  dangerSoft: '#fdecec',
  text: '#0f172a',
  textMuted: '#475569',
  border: '#dbe3ee',
  surface: '#ffffff',
  background: '#f3f6fb',
} as const;

/** Chart series in a fixed order, distinguishable for common colour-vision deficiencies. */
export const chartPalette = ['#1d4ed8', '#0f8b8d', '#f59e0b', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#ea580c'];

/** Pendency ageing buckets: calm to alarming. */
export const ageingColors = ['#5eb98a', '#facc15', '#f59e0b', '#ea580c', '#b91c1c'] as const;

export const fontFamily =
  '"Segoe UI", system-ui, -apple-system, Roboto, "Noto Sans", "Noto Sans Devanagari", "Helvetica Neue", Arial, sans-serif';

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: colors.royal,
    colorInfo: colors.royal,
    colorSuccess: colors.success,
    colorWarning: colors.warningFill,
    colorError: colors.danger,
    colorLink: colors.royal,
    colorText: colors.text,
    colorTextSecondary: colors.textMuted,
    colorBorder: colors.border,
    colorBorderSecondary: '#e7edf5',
    colorBgLayout: colors.background,
    borderRadius: 8,
    borderRadiusLG: 12,
    fontFamily,
    fontSize: 14,
    controlHeight: 36,
    boxShadowTertiary: '0 1px 2px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.04)',
  },
  components: {
    Layout: { siderBg: colors.navy, headerBg: colors.surface, headerHeight: 64, headerPadding: '0 20px', bodyBg: colors.background },
    Menu: {
      darkItemBg: colors.navy,
      darkSubMenuItemBg: colors.navy,
      darkItemColor: '#c7d2e3',
      darkItemHoverColor: '#ffffff',
      darkItemHoverBg: colors.navyLight,
      darkItemSelectedBg: colors.royal,
      darkItemSelectedColor: '#ffffff',
      itemBorderRadius: 8,
      itemMarginInline: 10,
      itemHeight: 42,
    },
    Card: { headerFontSize: 15, headerHeightSM: 44, paddingLG: 20 },
    Table: { headerBg: '#eef2f8', headerColor: colors.navy, headerSplitColor: 'transparent', rowHoverBg: colors.royalSoft, cellPaddingBlockSM: 8 },
    Statistic: { titleFontSize: 13, contentFontSize: 26 },
    Tabs: { itemSelectedColor: colors.royal, inkBarColor: colors.royal },
    Segmented: { itemSelectedBg: colors.royal, itemSelectedColor: '#ffffff' },
    Button: { primaryShadow: '0 1px 2px rgba(29, 78, 216, 0.25)', fontWeight: 500 },
  },
};
