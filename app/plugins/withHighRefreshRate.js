const { withMainActivity } = require('@expo/config-plugins');

/**
 * Expo Config Plugin to enable 120Hz refresh rate on Android (Kotlin).
 * Injects a setHighRefreshRate() method into MainActivity and calls it from onCreate.
 */
const withHighRefreshRate = (config) => {
  return withMainActivity(config, async (modConfig) => {
    const mainActivity = modConfig.modResults;

    if (mainActivity.contents.includes('setHighRefreshRate')) {
      return modConfig;
    }

    // Add required imports after the package declaration
    if (!mainActivity.contents.includes('import android.os.Build')) {
      mainActivity.contents = mainActivity.contents.replace(
        /(package [^\n]+\n)/,
        '$1\nimport android.os.Build\n'
      );
    }

    if (!mainActivity.contents.includes('import android.view.WindowManager')) {
      mainActivity.contents = mainActivity.contents.replace(
        /(import android\.os\.Build\n)/,
        '$1import android.view.WindowManager\n'
      );
    }

    const highRefreshMethod = `
    private fun setHighRefreshRate() {
        try {
            val window = window ?: return
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                window.attributes.layoutInDisplayCutoutMode =
                    android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                val display = windowManager.defaultDisplay
                val modes = display.supportedModes
                var highestMode: android.view.Display.Mode? = null
                var highestRefresh = 0f
                for (mode in modes) {
                    if (mode.refreshRate > highestRefresh) {
                        highestRefresh = mode.refreshRate
                        highestMode = mode
                    }
                }
                highestMode?.let {
                    val params = window.attributes
                    params.preferredDisplayModeId = it.modeId
                    window.attributes = params
                }
            }
        } catch (e: Exception) {
            // Silently fail on unsupported devices
        }
    }
`;

    // Inject the call in onCreate BEFORE adding the method body,
    // so the idempotency check does not match the method definition
    mainActivity.contents = mainActivity.contents.replace(
      /(super\.onCreate\([^)]*\))/,
      '$1\n        setHighRefreshRate()'
    );

    // Insert method before the final closing brace of the class
    const lastBraceIndex = mainActivity.contents.lastIndexOf('}');
    mainActivity.contents =
      mainActivity.contents.slice(0, lastBraceIndex) +
      highRefreshMethod + '\n' +
      mainActivity.contents.slice(lastBraceIndex);

    return modConfig;
  });
};

module.exports = withHighRefreshRate;
