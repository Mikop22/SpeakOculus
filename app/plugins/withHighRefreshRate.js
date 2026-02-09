const { withMainActivity } = require('@expo/config-plugins');

/**
 * Expo Config Plugin to enable 120Hz refresh rate on Android (Kotlin)
 */
const withHighRefreshRate = (config) => {
  return withMainActivity(config, async (config) => {
    const mainActivity = config.modResults;

    // Check if already modified
    if (mainActivity.contents.includes('setHighRefreshRate')) {
      return config;
    }

    // Add required imports if not present
    if (!mainActivity.contents.includes('import android.os.Build')) {
      // Find the first import statement and add our import after the package line
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

    // Add the high refresh rate function before the closing brace of the class
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
            // Silently fail
        }
    }
`;

    // Call setHighRefreshRate() in onCreate after super.onCreate
    // IMPORTANT: Must inject the call BEFORE adding the method body,
    // otherwise the includes check sees "setHighRefreshRate()" in the method definition
    mainActivity.contents = mainActivity.contents.replace(
      /(super\.onCreate\([^)]*\))/,
      '$1\n        setHighRefreshRate()'
    );

    // Find the last closing brace and insert method before it
    const lastBraceIndex = mainActivity.contents.lastIndexOf('}');
    mainActivity.contents =
      mainActivity.contents.slice(0, lastBraceIndex) +
      highRefreshMethod + '\n' +
      mainActivity.contents.slice(lastBraceIndex);

    return config;
  });
};

module.exports = withHighRefreshRate;
