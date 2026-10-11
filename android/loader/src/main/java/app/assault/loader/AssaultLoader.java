package app.assault.loader;

import android.app.*;
import android.content.*;
import android.content.res.*;
import android.graphics.Color;
import android.view.*;
import android.widget.*;
import de.robv.android.xposed.*;
import de.robv.android.xposed.callbacks.XC_LoadPackage;
import java.lang.reflect.Method;
import java.io.*;
import java.util.*;
import org.json.JSONObject;
import app.assault.shared.AccountSettings;

public final class AssaultLoader implements IXposedHookLoadPackage, IXposedHookZygoteInit {
    private static String modulePath;
    private final Set<Object> initialized = Collections.newSetFromMap(new WeakHashMap<>());
    private final Set<Activity> activities = Collections.newSetFromMap(new WeakHashMap<>());
    private final Set<Class<?>> callbackClasses = new HashSet<>();
    private Context context;
    private String failure;
    private String hookName = "No compatible script hook";
    @Override public void initZygote(StartupParam param) { modulePath=param.modulePath; }
    @Override public void handleLoadPackage(XC_LoadPackage.LoadPackageParam param) {
        if (!"com.discord".equals(param.packageName) || !param.packageName.equals(param.processName)) return;
        XposedHelpers.findAndHookMethod(Application.class,"attach",Context.class,new XC_MethodHook() {
            @Override protected void afterHookedMethod(MethodHookParam hook) { context=(Context)hook.args[0]; HtmlExport.clearOldCache(context); AddonDocuments.cleanup(context); Appearance.initialize(context,param.classLoader); }
        });
        AddonDocuments.install(param.classLoader);
        boolean hooked=false;
        for(String name: new String[]{"com.facebook.react.bridge.CatalystInstanceImpl", "com.facebook.react.runtime.ReactInstance$loadJSBundle$1", "com.facebook.react.runtime.ReactInstance$1"}) {
            try {
                Class<?> cls=param.classLoader.loadClass(name);
                Method assets=cls.getDeclaredMethod("loadScriptFromAssets",AssetManager.class,String.class,boolean.class);
                Method file=cls.getDeclaredMethod("loadScriptFromFile",String.class,String.class,boolean.class);
                XC_MethodHook hook=new XC_MethodHook() {
                    @Override protected void beforeHookedMethod(MethodHookParam call) {
                        if(context==null || initialized.contains(call.thisObject))return;
                        initialized.add(call.thisObject);
                        try {
                            var prefs=context.getSharedPreferences("assault",0);
                            if(prefs.getBoolean("safeMode",false) || !prefs.getBoolean("addonRuntime",true))return;
                            JSONObject config=AccountSettings.read(prefs);
                            for(String key:new String[]{"antiDelete","antiEdit","noTrack","captureEnabled","captureAttachments","redactAuthors","blockCrashReports","silentTyping","maskTokens","ghostPingAlert"})
                                config.put(key,prefs.getBoolean(key,key.equals("noTrack")||key.equals("captureEnabled")||key.equals("captureAttachments")||key.equals("blockCrashReports")||key.equals("maskTokens")||key.equals("ghostPingAlert")));
                            config.put("maxMessages",prefs.getInt("maxMessages",500)).put("maxEdits",prefs.getInt("maxEdits",20))
                                .put("memoryKiB",prefs.getInt("memoryKiB",4096)).put("retentionMinutes",prefs.getInt("retentionMinutes",0));
                            File globals=new File(context.getCacheDir(),"assault-config.js");
                            try(Writer out=new OutputStreamWriter(new FileOutputStream(globals),java.nio.charset.StandardCharsets.UTF_8)) { out.write("globalThis.__PYON_LOADER__="+Appearance.identity()+";globalThis.__ASSAULT_CONFIG__="+config+";"); }
                            XposedBridge.invokeOriginalMethod(file,call.thisObject,new Object[]{globals.getPath(),globals.getPath(),call.args[2]});
                            var resources=XModuleResources.createInstance(modulePath,null);
                            loadOptionalAddons(assets,call.thisObject,resources.getAssets(),call.args[2]);
                            XposedBridge.invokeOriginalMethod(assets,call.thisObject,new Object[]{resources.getAssets(),"assets://assault-runtime.js",call.args[2]});
                            for(String script:new String[]{"rich-presence.js","account-controls.js","history-export.js", "html-export.js","assault.js"})
                                XposedBridge.invokeOriginalMethod(assets,call.thisObject,new Object[]{resources.getAssets(),"assets://"+script,call.args[2]});
                        } catch(Throwable e) { failure="Injection failed: "+e.getClass().getSimpleName()+". Enable safe mode and restart Discord."; XposedBridge.log(e); }
                    }
                };
                XposedBridge.hookMethod(assets,hook); XposedBridge.hookMethod(file,hook); hooked=true; hookName=name;
            } catch(Throwable unsupported) { XposedBridge.log("Assault: unsupported script hook " + name); }
        }
        if(!hooked)failure="This Discord build has an unsupported React Native loader. Update Assault Manager.";
        XposedHelpers.findAndHookMethod(Activity.class,"onPostResume",new XC_MethodHook() {
            @Override protected void afterHookedMethod(MethodHookParam param) {
                Activity activity=(Activity)param.thisObject;
                if(!activity.getClass().getName().startsWith("com.discord."))return;
                if(callbackClasses.add(activity.getClass())) {
                    hookCallback(activity.getClass(),"onNewIntent",new Class<?>[]{Intent.class},new XC_MethodHook(){
                        @Override protected void afterHookedMethod(MethodHookParam call){Controls.receiveProfile((Activity)call.thisObject,(Intent)call.args[0]);}
                    });
                    hookCallback(activity.getClass(),"onActivityResult",new Class<?>[]{int.class,int.class,Intent.class},new XC_MethodHook(){
                        @Override protected void afterHookedMethod(MethodHookParam call){HtmlExport.result((Activity)call.thisObject,(int)call.args[0],(int)call.args[1],(Intent)call.args[2]);AddonDocuments.result((Activity)call.thisObject,(int)call.args[0],(int)call.args[1],(Intent)call.args[2]);}
                    });
                }
                AddonDocuments.resumed(activity);
                Controls.receiveProfile(activity,activity.getIntent());
                if(activities.contains(activity))return;
                activities.add(activity);
                ViewGroup decor=(ViewGroup)activity.getWindow().getDecorView();
                try {
                    ImageButton button=new ImageButton(activity); button.setContentDescription("Assault controls");
                    var resources=XModuleResources.createInstance(modulePath,null);
                    button.setImageDrawable(resources.getDrawable(R.drawable.ic_assault_foreground,null));
                    button.setBackgroundTintList(ColorStateList.valueOf(Color.rgb(9,9,11)));
                    float density=activity.getResources().getDisplayMetrics().density;
                    boolean left=activity.getSharedPreferences("assault",0).getBoolean("leftControl",false);
                    FrameLayout.LayoutParams layout=new FrameLayout.LayoutParams(Math.round(48*density),Math.round(48*density),Gravity.TOP|(left?Gravity.START:Gravity.END));
                    layout.topMargin=Math.round(48*density); layout.setMarginStart(Math.round(8*density));layout.setMarginEnd(Math.round(8*density));
                    decor.addView(button,layout);FloatingControl.attach(activity,decor,button);button.setOnClickListener(v->Controls.show(activity,failure,hookName));
                } catch(RuntimeException error) { XposedBridge.log("Assault controls unavailable: " + error.getClass().getSimpleName()); }
            }
        });
    }
    private void loadOptionalAddons(Method assets,Object instance,AssetManager resources,Object synchronous) {
        try { XposedBridge.invokeOriginalMethod(assets,instance,new Object[]{resources,"assets://addons.js",synchronous}); }
        catch(Throwable error) {
            failure="Addon screens could not load. Existing runtime features remain available; update Assault Manager and prepare the client again.";
            XposedBridge.log(error);
        }
    }
    private static void hookCallback(Class<?> type,String name,Class<?>[] args,XC_MethodHook hook) {
        while(type!=null) {
            try{XposedBridge.hookMethod(type.getDeclaredMethod(name,args),hook);return;}
            catch(NoSuchMethodException absent){type=type.getSuperclass();}
            catch(Throwable unsupported){XposedBridge.log("Assault callback unavailable: "+name);return;}
        }
        XposedBridge.log("Assault: unsupported activity callback "+name);
    }

}
