package app.assault.loader;

import android.content.Context;
import android.content.res.*;
import android.graphics.Color;
import de.robv.android.xposed.*;
import org.json.*;
import java.io.*;
import java.lang.reflect.Method;
import java.util.*;

/** Native theme integration for the Revenge theme-file contract (GPL-3.0). */
final class Appearance {
    private static JSONObject theme;
    static String status = "Discord default colors";
    static JSONObject identity() throws JSONException {
        JSONObject identity = new JSONObject().put("loaderName","Hypercord").put("loaderVersion",BuildConfig.VERSION_NAME)
            .put("hasThemeSupport",true).put("storedTheme",theme == null ? JSONObject.NULL : theme);
        return identity;
    }
    static void initialize(Context context, ClassLoader loader) {
        var prefs=context.getSharedPreferences("assault",0);
        if(prefs.getBoolean("safeMode",false) || !prefs.getBoolean("nativeThemes",true)){status="Native themes disabled";return;}
        if(prefs.getBoolean("amoledMode",false)) {
            try {
                Class<?> darker = loader.loadClass("com.discord.theme.DarkerTheme");
                for(String bgMethod: new String[]{"getBackgroundPrimary","getBackgroundSecondary","getBackgroundTertiary","getBackgroundMobilePrimary","getBackgroundMobileSecondary"}) {
                    try {
                        Method m = darker.getDeclaredMethod(bgMethod);
                        XposedBridge.hookMethod(m, new XC_MethodHook(){@Override protected void beforeHookedMethod(MethodHookParam p){p.setResult(0xFF000000);}});
                    } catch(ReflectiveOperationException ignored) {}
                }
            } catch(ClassNotFoundException ignored) {}
        }
        try {
            File file = new File(context.getFilesDir(),"pyoncord/current-theme.json");
            if(!file.isFile() || file.length()>1024*1024)return;
            String json=new String(java.nio.file.Files.readAllBytes(file.toPath()),java.nio.charset.StandardCharsets.UTF_8);
            if(json.trim().equals("null"))return;
            JSONObject parsed=new JSONObject(json);
            JSONObject data=parsed.optJSONObject("data");if(data==null)return;
            theme=parsed;
            int hooked=0, entries=0;
            JSONObject semantic=data.optJSONObject("semanticColors");
            if(semantic!=null)for(Iterator<String> it=semantic.keys();it.hasNext();) {
                if(++entries>256)break;
                String key=it.next(); JSONArray colors=semantic.optJSONArray(key);if(colors==null)continue;
                StringBuilder getter=new StringBuilder("get");
                for(String word:key.toLowerCase(Locale.ROOT).split("_"))if(!word.isEmpty())getter.append(Character.toUpperCase(word.charAt(0))).append(word.substring(1));
                String[] types={"com.discord.theme.DarkerTheme","com.discord.theme.LightTheme"};
                for(int i=0;i<Math.min(colors.length(),2);i++) {
                    if (!(colors.opt(i) instanceof String)) continue;
                    try { final int color=parseColor((String)colors.opt(i));
                        Method method=loader.loadClass(types[i]).getDeclaredMethod(getter.toString());
                        XposedBridge.hookMethod(method,new XC_MethodHook(){@Override protected void beforeHookedMethod(MethodHookParam p){p.setResult(color);}}); hooked++;
                    } catch(ReflectiveOperationException | IllegalArgumentException ignored) { }
                }
            }
            JSONObject raw=data.optJSONObject("rawColors");
            if(raw!=null) {
                Map<String,Integer> colors=new HashMap<>();
                android.util.SparseIntArray resolved=new android.util.SparseIntArray();
                for(Iterator<String> it=raw.keys();it.hasNext();) {
                    if(colors.size()>=512)break;
                    String key=it.next(); Object value=raw.opt(key);
                    if (!(value instanceof String)) continue;
                    try { colors.put(key.toLowerCase(Locale.ROOT),parseColor((String)value)); } catch(IllegalArgumentException ignored) { }
                }
                Class<?> utils=loader.loadClass("com.discord.theme.utils.ColorUtilsKt");
                XposedBridge.hookAllMethods(utils,"getColorCompat",new XC_MethodHook(){@Override protected void beforeHookedMethod(MethodHookParam p){
                    if(p.args.length<2 || !(p.args[1] instanceof Integer))return;
                    Resources resources=p.args[0] instanceof Context?((Context)p.args[0]).getResources():p.args[0] instanceof Resources?(Resources)p.args[0]:null;
                    if(resources==null)return;
                    try {
                        int id=(int)p.args[1];
                        synchronized(resolved){
                            int index=resolved.indexOfKey(id);
                            if(index>=0){p.setResult(resolved.valueAt(index));return;}
                            Integer color=colors.get(resources.getResourceEntryName(id));
                            if(color!=null){if(resolved.size()<512)resolved.put(id,color);p.setResult(color);}
                        }
                    }catch(Resources.NotFoundException ignored){}
                }});
            }
            status="Theme active · "+hooked+" semantic color hooks";
        } catch(Exception error) {status="Theme fallback: "+error.getClass().getSimpleName();XposedBridge.log("Hypercord theme: "+error);}
    }
    private static int parseColor(String value) { return Color.parseColor(value.length()==9?"#"+value.substring(7,9)+value.substring(1,7):value); }
}
