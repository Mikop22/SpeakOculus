import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { View, StyleSheet, Text, Platform, TouchableOpacity } from 'react-native';
import { CameraView, useCameraPermissions, CameraCapturedPicture } from 'expo-camera';

export type CameraFacing = 'front' | 'back';

export interface ViewfinderRef {
  takePictureAsync: (options?: {
    quality?: number;
    base64?: boolean;
    skipProcessing?: boolean;
    shutterSound?: boolean;
  }) => Promise<CameraCapturedPicture | undefined>;
}

interface ViewfinderProps {
  isCameraOn: boolean;
  facing?: CameraFacing;
  onPermissionGranted?: () => void;
}

export const Viewfinder = forwardRef<ViewfinderRef, ViewfinderProps>(
  ({ isCameraOn, facing = 'front', onPermissionGranted }, ref) => {
    const [permission, requestPermission] = useCameraPermissions();
    const cameraRef = useRef<CameraView>(null);

    useImperativeHandle(ref, () => ({
      takePictureAsync: async (options = {}) => {
        if (!cameraRef.current) return undefined;
        try {
          return await cameraRef.current.takePictureAsync({
            quality: options.quality ?? 0.4,
            base64: options.base64 ?? true,
            skipProcessing: options.skipProcessing ?? true,
            shutterSound: options.shutterSound ?? false,
          });
        } catch (error) {
          console.error('[Viewfinder] Failed to take picture:', error);
          return undefined;
        }
      },
    }), []);

    useEffect(() => {
      if (!permission) return;
      if (!permission.granted && permission.canAskAgain) {
        requestPermission();
      }
      if (permission.granted) {
        onPermissionGranted?.();
      }
    }, [permission]);

    const handleRequestPermission = async () => {
      const result = await requestPermission();
      if (result.granted) {
        onPermissionGranted?.();
      }
    };

    if (!permission) {
      return <View style={styles.container} />;
    }

    // On web, CameraView triggers the browser permission prompt directly
    if (Platform.OS !== 'web' && !permission.granted) {
      return (
        <View style={[styles.container, styles.cameraOff]}>
          <TouchableOpacity onPress={handleRequestPermission} style={styles.permissionButton}>
            <Text style={styles.permissionText}>Tap to enable camera</Text>
            <Text style={styles.permissionSubText}>Permissions are required for the viewfinder</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (!isCameraOn) {
      return (
        <View style={[styles.container, styles.cameraOff]}>
          <Text style={styles.statusText}>Camera Off</Text>
        </View>
      );
    }

    return (
      <View style={styles.container}>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing={facing}
          active={true}
          mute={true}
        />
      </View>
    );
  }
);

Viewfinder.displayName = 'Viewfinder';

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  cameraOff: {
    backgroundColor: '#1C1C1E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionButton: {
    padding: 20,
    alignItems: 'center',
  },
  permissionText: {
    color: '#34C759',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  permissionSubText: {
    color: '#888',
    fontSize: 14,
  },
  statusText: {
    color: '#666',
    marginTop: 20,
  },
});
