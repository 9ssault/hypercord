# language: ProGuard, file: android/loader/proguard-rules.pro
#
# The loader runs inside Discord's process, called by name from the framework and reaching
# into Discord's own classes reflectively. Every rule here protects a name looked up from
# outside this module, so an obfuscated build is one that injects nothing and says nothing.

# The entry point in the `xposed_init` asset. Renamed, and the injected process loads a
# class that does not exist - with no error anywhere a user can see.
-keep class app.assault.loader.AssaultLoader { *; }
-keepnames class app.assault.loader.AssaultLoader

# The other loader classes are reached from AssaultLoader and from each other, and two of
# them (AddonTransfer, ScriptDocuments) are called through hook callbacks where the call
# site is a method reference resolved by name.
-keep class app.assault.loader.** { *; }
-keepclassmembers class app.assault.loader.** { *; }

# AccountSettings comes from app.assault.shared (absent from the tree today; see build.gradle).
-keep class app.assault.shared.** { *; }

# Xposed's own classes are supplied by the loaded process, not packaged here, so R8 must
# not warn about them being missing and must not inline calls into them.
-keep class de.robv.android.xposed.** { *; }
-keepclassmembers class de.robv.android.xposed.** { *; }
-dontwarn de.robv.android.xposed.**

# The hook callbacks are resolved by name through XposedBridge, and JSONObject round-trips
# the messages the runtime and the manager exchange: field names are the protocol.
-keepattributes Signature, *Annotation*, InnerClasses, EnclosingMethod
-keepclassmembers class ** {
    @com.google.gson.annotations.SerializedName <fields>;
}

# Readable stack traces from inside a patched Discord, without shipping sources.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
