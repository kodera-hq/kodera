import SwiftUI

/// Bind generated asset names and token sizes to native Dynamic Type styles.
enum NativeTypography {
    static var title: Font {
        .custom(FontAssets.sansSemibold, size: KoderaTokens.FontSize.s2xl, relativeTo: .largeTitle)
    }
    static var heading: Font {
        .custom(FontAssets.sansSemibold, size: KoderaTokens.FontSize.xl, relativeTo: .title2)
    }
    static var body: Font {
        .custom(FontAssets.sansRegular, size: KoderaTokens.FontSize.lg, relativeTo: .body)
    }
    static var emphasis: Font {
        .custom(FontAssets.sansSemibold, size: KoderaTokens.FontSize.lg, relativeTo: .body)
    }
    static var caption: Font {
        .custom(FontAssets.sansRegular, size: KoderaTokens.FontSize.sm, relativeTo: .caption)
    }
    static var wordmark: Font {
        .custom(FontAssets.sansBold, size: KoderaTokens.FontSize.xl, relativeTo: .title2)
    }
    static var monoBody: Font {
        .custom(FontAssets.monoRegular, size: KoderaTokens.FontSize.md, relativeTo: .callout)
    }
    static var monoCaption: Font {
        .custom(FontAssets.monoRegular, size: KoderaTokens.FontSize.xs, relativeTo: .caption2)
    }
}

extension KoderaTokens {
    static func cielPalette(for colorScheme: ColorScheme) -> Palette {
        colorScheme == .dark ? cielNuit : ciel
    }

    static func cielTheme(for colorScheme: ColorScheme) -> Theme {
        colorScheme == .dark ? .cielNuit : .ciel
    }
}
