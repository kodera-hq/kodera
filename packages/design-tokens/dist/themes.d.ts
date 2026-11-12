// GENERATED FILE — DO NOT EDIT.
// Written by scripts/build.mjs from the theme registry (scripts/lib/themes.mjs),
// the one list every generator reads. Editing this file by hand is undone by
// the next build and caught by `npm run check:drift`.

/** A `[data-theme]` attribute value. */
export type ThemeId = 'light' | 'dark' | 'black' | 'ciel' | 'ciel-nuit';
export type ThemeFamily = 'givre' | 'ciel';
export type ThemeMode = 'light' | 'dark' | 'black';
export type ThemeScheme = 'light' | 'dark';

export interface ThemeInfo {
  readonly id: ThemeId;
  readonly family: ThemeFamily;
  readonly mode: ThemeMode;
  /** The `color-scheme` native controls render in under this theme. */
  readonly scheme: ThemeScheme;
  /** True for the one theme an unthemed document renders in. */
  readonly default: boolean;
}

export interface ThemeFamilyInfo {
  /** `flat`: opaque surfaces only. `glass`: translucent materials are allowed. */
  readonly material: 'flat' | 'glass';
  /** `none`: every gradient is one colour. `controlled`: the bounded gradient grammar applies. */
  readonly gradient: 'none' | 'controlled';
  readonly themes: readonly ThemeId[];
}

export declare const themes: readonly ThemeInfo[];
export declare const themeIds: readonly ThemeId[];
export declare const defaultTheme: ThemeId;
export declare const themeFamilies: Readonly<Record<ThemeFamily, ThemeFamilyInfo>>;
export declare function themeFor(family: ThemeFamily, mode: ThemeMode): ThemeInfo | undefined;
