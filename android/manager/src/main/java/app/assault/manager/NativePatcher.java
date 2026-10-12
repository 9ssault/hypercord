package app.assault.manager;

import java.io.File;
import java.util.List;
import org.lsposed.patch.ApkPatcher;
import org.lsposed.patch.PatchSpec;
import org.lsposed.patch.util.Logger;

final class NativePatcher {
    static List<File> patch(Logger logger, PatchSpec spec) throws Exception {
        return patch(logger, spec, List.of(), null);
    }
    static List<File> patch(Logger logger, PatchSpec spec, List<String> iconPaths, byte[] icon) throws Exception {
        return new ApkPatcher(logger, spec, iconPaths, icon).patch();
    }
}
