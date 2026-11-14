package io.kodera.android.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import io.kodera.android.R
import io.kodera.tokens.KoderaTokens

/** Resource bindings preserve the pinned font identities and generated weight/size values. */
internal object NativeTypography {
    private val sans = FontFamily(
        Font(R.font.plus_jakarta_sans_regular, KoderaTokens.FontWeight.regular),
        Font(R.font.plus_jakarta_sans_medium, KoderaTokens.FontWeight.medium),
        Font(R.font.plus_jakarta_sans_semibold, KoderaTokens.FontWeight.semibold),
        Font(R.font.plus_jakarta_sans_bold, KoderaTokens.FontWeight.bold),
    )
    private val mono = FontFamily(
        Font(R.font.ibm_plex_mono_regular, KoderaTokens.FontWeight.regular),
    )

    val title = TextStyle(fontFamily = sans, fontWeight = KoderaTokens.FontWeight.semibold, fontSize = KoderaTokens.FontSize.s2xl)
    val heading = TextStyle(fontFamily = sans, fontWeight = KoderaTokens.FontWeight.semibold, fontSize = KoderaTokens.FontSize.xl)
    val body = TextStyle(fontFamily = sans, fontWeight = KoderaTokens.FontWeight.regular, fontSize = KoderaTokens.FontSize.lg)
    val emphasis = TextStyle(fontFamily = sans, fontWeight = KoderaTokens.FontWeight.semibold, fontSize = KoderaTokens.FontSize.lg)
    val caption = TextStyle(fontFamily = sans, fontWeight = KoderaTokens.FontWeight.regular, fontSize = KoderaTokens.FontSize.sm)
    val wordmark = TextStyle(fontFamily = sans, fontWeight = KoderaTokens.FontWeight.bold, fontSize = KoderaTokens.FontSize.xl)
    val monoBody = TextStyle(fontFamily = mono, fontWeight = KoderaTokens.FontWeight.regular, fontSize = KoderaTokens.FontSize.md)
    val monoCaption = TextStyle(fontFamily = mono, fontWeight = KoderaTokens.FontWeight.regular, fontSize = KoderaTokens.FontSize.xs)

    val material = Typography(
        displayLarge = title.copy(fontSize = KoderaTokens.FontSize.s4xl),
        displayMedium = title.copy(fontSize = KoderaTokens.FontSize.s3xl),
        displaySmall = title,
        headlineLarge = title,
        headlineMedium = heading,
        headlineSmall = heading,
        titleLarge = heading,
        titleMedium = emphasis,
        titleSmall = emphasis.copy(fontSize = KoderaTokens.FontSize.md),
        bodyLarge = body,
        bodyMedium = body.copy(fontSize = KoderaTokens.FontSize.md),
        bodySmall = caption,
        labelLarge = emphasis,
        labelMedium = emphasis.copy(fontSize = KoderaTokens.FontSize.md),
        labelSmall = caption,
    )
}
