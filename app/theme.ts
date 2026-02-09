import { Platform, TextStyle } from 'react-native';

// SF Pro on iOS (system), Inter on Android
const fontFamily = Platform.select({
    ios: 'System', // SF Pro
    android: 'Inter_400Regular',
    default: 'System',
});

const fontFamilySemibold = Platform.select({
    ios: 'System',
    android: 'Inter_600SemiBold',
    default: 'System',
});

const fontFamilyBold = Platform.select({
    ios: 'System',
    android: 'Inter_700Bold',
    default: 'System',
});

export const THEME = {
    colors: {
        background: '#000000',
        surface: 'rgba(30, 30, 30, 0.85)',
        surfaceHighlight: 'rgba(255, 255, 255, 0.1)',
        surfaceElevated: 'rgba(44, 44, 46, 0.92)',
        textPrimary: '#FFFFFF',
        textSecondary: 'rgba(255, 255, 255, 0.6)',
        textTertiary: 'rgba(255, 255, 255, 0.35)',
        accent: '#34C759', // Green for connected/active
        accentDim: 'rgba(52, 199, 89, 0.25)',
        accentGlow: 'rgba(52, 199, 89, 0.4)',
        accentTeal: '#30D5C8',
        destructive: '#FF3B30', // Red for hangup
        iconDefault: '#FFFFFF',
        iconActive: '#000000',
        controlBackground: '#2C2C2E',
        controlActive: '#FFFFFF',
        glassBorder: 'rgba(255, 255, 255, 0.12)',
        glassHighlight: 'rgba(255, 255, 255, 0.06)',
    },
    spacing: {
        xs: 4,
        sm: 8,
        md: 16,
        lg: 24,
        xl: 32,
    },
    borderRadius: {
        sm: 8,
        md: 12,
        lg: 20,
        xl: 32,
        pill: 999,
    },
    blur: {
        intensity: 80,
        tint: 'dark' as const,
    },
    // Typography - SF Pro on iOS, Inter on Android
    typography: {
        // Large Title (34pt) - "FaceTime" header
        largeTitle: {
            fontFamily: fontFamilyBold,
            fontSize: 34,
            fontWeight: '700',
            letterSpacing: 0.37,
        } as TextStyle,
        // Title 1 (28pt)
        title1: {
            fontFamily: fontFamilyBold,
            fontSize: 28,
            fontWeight: '700',
            letterSpacing: 0.36,
        } as TextStyle,
        // Title 2 (22pt)
        title2: {
            fontFamily: fontFamilyBold,
            fontSize: 22,
            fontWeight: '700',
            letterSpacing: 0.35,
        } as TextStyle,
        // Title 3 (20pt)
        title3: {
            fontFamily: fontFamilySemibold,
            fontSize: 20,
            fontWeight: '600',
            letterSpacing: 0.38,
        } as TextStyle,
        // Headline (17pt semibold) - Caller names
        headline: {
            fontFamily: fontFamilySemibold,
            fontSize: 17,
            fontWeight: '600',
            letterSpacing: -0.41,
        } as TextStyle,
        // Body (17pt regular) - Default text
        body: {
            fontFamily: fontFamily,
            fontSize: 17,
            fontWeight: '400',
            letterSpacing: -0.41,
        } as TextStyle,
        // Callout (16pt)
        callout: {
            fontFamily: fontFamily,
            fontSize: 16,
            fontWeight: '400',
            letterSpacing: -0.32,
        } as TextStyle,
        // Subheadline (15pt)
        subheadline: {
            fontFamily: fontFamily,
            fontSize: 15,
            fontWeight: '400',
            letterSpacing: -0.24,
        } as TextStyle,
        // Footnote (13pt) - Section headers like "TODAY"
        footnote: {
            fontFamily: fontFamily,
            fontSize: 13,
            fontWeight: '400',
            letterSpacing: -0.08,
        } as TextStyle,
        // Caption 1 (12pt) - Button labels
        caption1: {
            fontFamily: fontFamily,
            fontSize: 12,
            fontWeight: '400',
            letterSpacing: 0,
        } as TextStyle,
        // Caption 2 (11pt)
        caption2: {
            fontFamily: fontFamily,
            fontSize: 11,
            fontWeight: '400',
            letterSpacing: 0.07,
        } as TextStyle,
    },
};
