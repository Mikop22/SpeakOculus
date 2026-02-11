import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { LucideIcon } from 'lucide-react-native';
import { THEME } from '../theme';

interface FeatureToggleProps {
    icon: LucideIcon;
    label: string;
    isActive: boolean;
    onPress: () => void;
}

export const FeatureToggle = ({ icon: Icon, label, isActive, onPress }: FeatureToggleProps) => {
    return (
        <TouchableOpacity
            onPress={onPress}
            activeOpacity={0.6}
            style={[
                styles.container,
                isActive && styles.containerActive,
            ]}
        >
            <Icon
                size={15}
                color={isActive ? THEME.colors.iconActive : THEME.colors.iconDefault}
                strokeWidth={2}
            />
            <Text style={[styles.label, isActive ? styles.labelActive : styles.labelInactive]}>
                {label}
            </Text>
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 10,
        paddingHorizontal: THEME.spacing.sm,
        borderRadius: THEME.borderRadius.xl,
        gap: 6,
        backgroundColor: THEME.colors.controlBackground,
    },
    containerActive: {
        backgroundColor: THEME.colors.controlActive,
    },
    label: {
        ...THEME.typography.caption1,
        fontWeight: '600',
    },
    labelInactive: {
        color: THEME.colors.textPrimary,
    },
    labelActive: {
        color: '#000000',
    },
});
