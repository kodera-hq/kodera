package io.kodera.android.ui.theme

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import io.kodera.tokens.KoderaTokens

internal val LocalKoderaPalette = staticCompositionLocalOf { KoderaTokens.ciel }
internal val LocalKoderaMaterials = staticCompositionLocalOf { KoderaTokens.MaterialSet.ciel }

internal fun resolveCielTheme(darkTheme: Boolean): KoderaTokens.Theme =
    if (darkTheme) KoderaTokens.Theme.CielNuit else KoderaTokens.Theme.Ciel

@Composable
fun KoderaTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    themeOverride: KoderaTokens.Theme? = null,
    content: @Composable () -> Unit,
) {
    val activeTheme = themeOverride ?: resolveCielTheme(darkTheme)
    val palette = activeTheme.palette
    val materials = activeTheme.materials
    val base = if (activeTheme.isDark) darkColorScheme() else lightColorScheme()
    val colors = base.copy(
        primary = palette.action,
        onPrimary = palette.onInverse,
        primaryContainer = palette.accentSoft,
        onPrimaryContainer = palette.accentInk,
        inversePrimary = palette.action,
        secondary = palette.ink2,
        onSecondary = palette.surface,
        secondaryContainer = palette.muted,
        onSecondaryContainer = palette.ink,
        tertiary = palette.ink3,
        onTertiary = palette.surface,
        tertiaryContainer = palette.sunken,
        onTertiaryContainer = palette.ink,
        background = palette.page,
        onBackground = palette.ink,
        surface = palette.surface,
        onSurface = palette.ink,
        surfaceVariant = palette.sunken,
        onSurfaceVariant = palette.ink2,
        surfaceTint = palette.action,
        inverseSurface = palette.inverse,
        inverseOnSurface = palette.onInverse,
        error = palette.bad,
        onError = palette.onInverse,
        errorContainer = palette.badSoft,
        onErrorContainer = palette.badInk,
        outline = palette.borderInput,
        outlineVariant = palette.borderSoft,
        scrim = palette.scrim,
        surfaceBright = palette.surface,
        surfaceDim = palette.sunken,
        surfaceContainerLowest = palette.page,
        surfaceContainerLow = palette.surface,
        surfaceContainer = palette.surface,
        surfaceContainerHigh = palette.elevated,
        surfaceContainerHighest = palette.muted,
    )
    CompositionLocalProvider(
        LocalKoderaPalette provides palette,
        LocalKoderaMaterials provides materials,
    ) {
        MaterialTheme(
            colorScheme = colors,
            typography = NativeTypography.material,
            shapes = Shapes(
                extraSmall = RoundedCornerShape(KoderaTokens.Radius.sm),
                small = RoundedCornerShape(KoderaTokens.Radius.sm),
                medium = RoundedCornerShape(KoderaTokens.Radius.md),
                large = RoundedCornerShape(KoderaTokens.Radius.lg),
                extraLarge = RoundedCornerShape(KoderaTokens.Radius.xl),
            ),
            content = content,
        )
    }
}

/**
 * Cobalt × Kodera — verre `ciel` translucent glass card consuming generated `KoderaTokens` panel
 * material, hairline border, and frost legibility in both light (`ciel`) and dark (`ciel-nuit`) modes.
 */
@Composable
internal fun CielGlassCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val palette = LocalKoderaPalette.current
    val materials = LocalKoderaMaterials.current
    val frostColor = materials.panel.tint.copy(alpha = materials.panel.alpha)
    Surface(
        modifier = modifier,
        color = frostColor,
        contentColor = palette.ink,
        shape = RoundedCornerShape(KoderaTokens.Radius.lg),
        border = BorderStroke(Dp.Hairline, palette.borderSoft),
        content = content,
    )
}

/** Compact pill badge consuming generated `KoderaTokens` tag/accent surfaces and hairline borders. */
@Composable
internal fun CielBadgePill(
    label: String,
    containerColor: Color,
    contentColor: Color,
    modifier: Modifier = Modifier,
) {
    val palette = LocalKoderaPalette.current
    Surface(
        modifier = modifier,
        color = containerColor,
        contentColor = contentColor,
        shape = RoundedCornerShape(KoderaTokens.Radius.full),
        border = BorderStroke(Dp.Hairline, palette.borderSoft),
    ) {
        Box(
            modifier = Modifier.padding(
                horizontal = KoderaTokens.Space.s2,
                vertical = KoderaTokens.Space.s1,
            ),
        ) {
            Text(text = label, style = NativeTypography.caption, color = contentColor)
        }
    }
}
