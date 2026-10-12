# language: ProGuard, file: android/manager/proguard-rules.pro
#
# What R8 must not rename, and why each one would break at runtime rather than at build
# time. Everything here is a name something outside this code looks up: the manifest, the
# LSPatch patcher's own reflection, or the JSON the manager writes for the loader.

# Classes the merged manifest names. A renamed component is a manifest pointing at a
# class that does not exist, which Android reports as "Unable to instantiate" long after
# the build succeeded.
-keep class app.assault.manager.ManagerActivity { *; }
-keep class app.assault.manager.ScriptProvider { *; }
-keep class app.assault.manager.ScriptResultReceiver { *; }
# Named by the manifest and absent from the tree today (see build.gradle): keeping them
# costs nothing and means the day they land, R8 does not remove the ones the manifest
# declares before the first install.
-keep class app.assault.manager.InstallReceiver { *; }
-keep class app.assault.manager.UpdateJob { *; }

# The shared module's screens are launched from this module by name.
-keep class app.assault.shared.** { *; }

# The patcher reads and writes LSPatch's own classes reflectively (PatchConfig, Constants)
# and reflects over apkzlib's signing structures. Names and annotations have to survive:
# Gson resolves model fields by their declared names, and an obfuscated field is a config
# that silently round-trips as an empty object.
-keep class org.lsposed.** { *; }
-keep class com.wind.meditor.** { *; }
-keep class com.android.tools.build.apkzlib.** { *; }
-keep class com.google.gson.** { *; }
-keepclassmembers class ** {
    @com.google.gson.annotations.SerializedName <fields>;
}
-keepattributes Signature, *Annotation*, InnerClasses, EnclosingMethod, MethodParameters

# Third-party code that R8 cannot see the whole of: the jar files declared in build.gradle
# are partial by nature (apkzlib's signing extension reaches into JDK internals), and a
# "missing class" warning about a class only used through reflection is not a defect.
-dontwarn com.android.tools.build.apkzlib.**
-dontwarn com.wind.meditor.**
-dontwarn org.lsposed.**
-dontwarn org.apache.commons.io.**
-dontwarn javax.annotation.**
-dontwarn org.slf4j.**

# Keep the line numbers, drop the source file names: a crash report from a repacked client
# is only readable if the stack trace can be mapped back, and nothing here ships sources.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
