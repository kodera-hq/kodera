package io.kodera.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import io.kodera.tokens.KoderaTokens

internal val LocalKoderaPalette = staticCompositionLocalOf { KoderaTokens.light }

@Composable
fun KoderaTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val palette = if (dark) KoderaTokens.dark else KoderaTokens.light
    val base = if (dark) darkColorScheme() else lightColorScheme()
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
    CompositionLocalProvider(LocalKoderaPalette provides palette) {
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
