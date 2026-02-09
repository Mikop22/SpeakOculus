import React, { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
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

    // Expose camera methods to parent via ref
    useImperativeHandle(ref, () => ({
      takePictureAsync: async (options = {}) => {
        if (!cameraRef.current) {
          console.warn('[Viewfinder] Camera ref not available');
          return undefined;
        }
        try {
          const photo = await cameraRef.current.takePictureAsync({
            quality: options.quality ?? 0.4,
            base64: options.base64 ?? true,
            skipProcessing: options.skipProcessing ?? true,
            shutterSound: options.shutterSound ?? false, // Silent by default
          });
          console.log('[Viewfinder] Photo captured, size:', photo?.width, 'x', photo?.height);
          return photo;
        } catch (error) {
          console.error('[Viewfinder] Failed to take picture:', error);
          return undefined;
        }
      },
    }), []);

    useEffect(() => {
      if (permission) {
        console.log('[Viewfinder] Camera Permission:', permission.status, permission.granted);
        // Auto-request permission if not yet determined
        if (!permission.granted && permission.canAskAgain) {
          console.log('[Viewfinder] Auto-requesting camera permission...');
          requestPermission();
        }
        if (permission.granted) {
          onPermissionGranted?.();
        }
      }
    }, [permission]);

    const handleRequestPermission = async () => {
      console.log('[Viewfinder] Requesting permission...');
      const result = await requestPermission();
      console.log('[Viewfinder] Request result:', result);
      if (result.granted) {
        onPermissionGranted?.();
      }
    };

    if (!permission) {
      // Permission loading
      return <View style={styles.container} />;
    }

    // On Web, we bypass this check and let the CameraView try to load,
    // which often triggers the permission prompt better than the hook logic.
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
          <View style={styles.placeholder} />
          <Text style={styles.statusText}>Camera Off</Text>
        </View>
      );
    }

    console.log('[Viewfinder] Rendering camera, facing:', facing, 'permission:', permission?.granted);

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

// Display name for debugging
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
  placeholder: {
    // Empty
  }
});
