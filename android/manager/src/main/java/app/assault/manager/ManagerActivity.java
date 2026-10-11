package app.assault.manager;

import android.app.*;
import android.app.job.*;
import android.content.*;
import android.content.pm.*;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import java.io.*;
import app.assault.shared.AccountSettings;
import app.assault.shared.CommandGuide;
import app.assault.shared.RichPresence;
import java.util.*;
import java.util.concurrent.*;

public class ManagerActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView status, version, detail, loaderStatus;
    private Button install, fetch, managerInstall, cancel;
    private final java.util.concurrent.atomic.AtomicBoolean checking = new java.util.concurrent.atomic.AtomicBoolean();
    private final SharedPreferences.OnSharedPreferenceChangeListener changes=this::changed;
    private ProgressBar progress;
    private boolean awaitingPermission;
    private long latest;
    private final Runnable refresh = this::render;
    private void changed(SharedPreferences prefs,String key){handler.removeCallbacks(refresh);handler.postDelayed(refresh,100);}
    private static final int BG = 0xff09090b, CARD = 0xff19191e, MINT = 0xffff6370, WHITE = 0xffedf3fa, MUTED = 0xffa6b4c8;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        awaitingPermission = state != null && state.getBoolean("permission");
        LinearLayout page = new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL); page.setPadding(dp(24),dp(20),dp(24),dp(24)); page.setBackgroundColor(BG);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.addView(page); setContentView(scroll);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            scroll.setOnApplyWindowInsetsListener((view, insets) -> { var bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()); view.setPadding(bars.left,bars.top,bars.right,bars.bottom); return insets; });
        } else scroll.setFitsSystemWindows(true);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::finish);
        ImageView logo=new ImageView(this);logo.setImageResource(R.drawable.ic_launcher);page.addView(logo,new LinearLayout.LayoutParams(dp(72),dp(72)));
        text(page, "AS / ASSAULT", 14, MINT, true);
        text(page, "Your Discord.\nYour control.", 36, WHITE, true);
        text(page, "MANAGER  /  "+BuildConfig.VERSION_NAME, 12, MUTED, true);
        LinearLayout hero = card(page);
        text(hero, "NATIVE DISCORD", 12, MINT, true);
        version = text(hero, "Checking your client…", 25, WHITE, true);
        detail = text(hero, "", 14, MUTED, false);
        loaderStatus = text(hero, "", 14, MINT, false);
        text(hero, "1  Download verified client splits\n2  Merge the included loader\n3  Confirm installation in Android", 14, MUTED, false);
        fetch = button(hero, "Download & prepare client", true, v -> prepare());
        install = button(hero, "Install prepared update", false, v -> requestInstall());
        cancel=button(hero,"Cancel preparation",false,v->{ClientEngine.cancel();message("Cancellation requested. Downloads stop at the next progress boundary; patching stops before publication.");});
        button(hero, "Open Assault", false, v -> {
            Intent launch = getPackageManager().getLaunchIntentForPackage(ClientEngine.CLIENT);
            if (launch == null) message("Install the client first."); else {try {startActivity(launch);}catch(RuntimeException e){message("Android could not open the client.");}}
        });
        button(page, "Code runner setup", false, v -> ScriptSetup.show(this));
        LinearLayout controls = card(page);
        text(controls, "Account controls", 21, WHITE, true);
        text(controls, "Choose a built-in profile for the signed-in client: local commands, own-message reactions or custom presence. No account token is needed.", 14, MUTED, false);
        button(controls,"Configure profile",false,v->AccountSettings.show(this,getSharedPreferences("manager",0),()->message("Profile saved. Tap Apply profile to client, then confirm in the client.")));
        button(controls,"Rich presence builder",false,v->RichPresence.show(this,getSharedPreferences("manager",0),()->message("Rich presence saved. Apply profile to client, confirm there, then restart it.")));
        button(controls,"Command guide",false,v->CommandGuide.show(this));
        button(controls,"Apply profile to client",false,v->{
            Intent launch=getPackageManager().getLaunchIntentForPackage(ClientEngine.CLIENT);
            if(launch==null){message("Install the client first.");return;}
            launch.putExtra(AccountSettings.EXTRA,AccountSettings.read(getSharedPreferences("manager",0)).toString());
            try{startActivity(launch);}catch(RuntimeException e){message("Could not open the client. Use AS → Account controls inside the client.");}
        });
        LinearLayout updates = card(page);
        text(updates, "Updates, handled", 21, WHITE, true);
        Switch auto = new Switch(this); auto.setText("Prepare updates automatically"); auto.setTextColor(WHITE); auto.setTextSize(15);
        auto.setChecked(getSharedPreferences("manager",0).getBoolean("auto", true)); updates.addView(auto);
        text(updates, "Checks on your chosen schedule. Defaults: daily, Wi-Fi, charging. Android asks before installation. Keep Manager installed and do not clear its app data: this deletes your client signing key. There is no key recovery; future updates would require reinstalling the client and losing its local app data.", 13, MUTED, false);
        auto.setOnCheckedChangeListener((b,on) -> { getSharedPreferences("manager",0).edit().putBoolean("auto",on).apply(); schedule(this); });
        policySwitch(updates,"Only on unmetered networks","unmetered",true);
        policySwitch(updates,"Only while charging","charging",true);
        button(updates,"Update frequency",false,v->{
            int[] hours={6,24,72};String[] labels={"Every 6 hours","Daily","Every 3 days"};int selected=1;
            for(int i=0;i<hours.length;i++)if(hours[i]==getSharedPreferences("manager",0).getInt("intervalHours",24))selected=i;
            new AlertDialog.Builder(this).setTitle("Update frequency").setSingleChoiceItems(labels,selected,(d,i)->{getSharedPreferences("manager",0).edit().putInt("intervalHours",hours[i]).apply();schedule(this);d.dismiss();}).setNegativeButton("Cancel",null).show();
        });
        button(updates, "Check client & manager updates", false, v -> checkUpdates(true));
        managerInstall = button(updates, "Install Manager update", false, v -> {
            if (!getPackageManager().canRequestPackageInstalls()) {
                message("Grant install permission, then tap Install Manager update again.");
                openInstallPermission();
            } else installFiles(List.of(ManagerUpdater.prepared(this)),getPackageName());
        });
        LinearLayout activity = card(page);
        text(activity, "Activity", 21, WHITE, true);
        progress = new ProgressBar(this); activity.addView(progress);
        status = text(activity, "Ready", 14, MUTED, false); status.setTextIsSelectable(true);
        button(activity,"Clear failed downloads",false,v->{
            try{worker.execute(()->{try{ClientEngine.clearDownloads(getApplicationContext());message("Failed downloads cleared. Prepared client and signing key retained.");}catch(Exception e){message(e.getMessage());}});}catch(RejectedExecutionException e){message("Reopen Manager to retry.");}
        });
        button(activity,"Copy diagnostics",false,v->{
            try{getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Assault diagnostics","Manager "+BuildConfig.VERSION_NAME+"\nAPI "+Build.VERSION.SDK_INT+" · "+Build.SUPPORTED_ABIS[0]+"\nInstalled Discord: "+ClientEngine.installed(this)+"\nLatest: "+latest+"\nPrepared APKs: "+ClientEngine.prepared(this).size()));message("Diagnostics copied without messages, tokens or signing material.");}catch(RuntimeException e){message("Clipboard unavailable.");}
        });
        LinearLayout about = card(page);
        text(about, "A separate manager. A native client.", 19, WHITE, true);
        text(about, "Discord supplies chat, voice, DMs and its mobile interface. Assault adds its loader, message controls, plugins and themes. No WebView client.", 14, MUTED, false);
        button(about, "Client app settings", false, v -> {
            try { startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:com.discord"))); }
            catch (RuntimeException e) { message("The client is not installed."); }
        });
        button(about,"Open-source notices",false,v->new AlertDialog.Builder(this).setTitle("Open-source notices").setMessage("LSPatch: GPL-3.0\nRevenge runtime: BSD-3-Clause (Assault display branding)\nXposed API: Apache-2.0\n\nSource and full licenses: github.com/hypercharacterization/assault").setPositiveButton("OK",null).show());
        schedule(this); checkUpdates(false);
    }
    private void render() {
        long installed = ClientEngine.installed(this);
        latest = getSharedPreferences("manager",0).getLong("latest",latest);
        version.setText(installed == 0 ? "Make it yours." : "Discord " + installed);
        detail.setText("Android " + Build.VERSION.RELEASE + " · " + Build.SUPPORTED_ABIS[0] + (latest > 0 ? "\nAvailable build " + latest : "\nUse Check updates to fetch stable release"));
        var prefs = getSharedPreferences("manager", 0);
        boolean ready = !ClientEngine.prepared(this).isEmpty();
        loaderStatus.setText("Included loader " + BuildConfig.VERSION_NAME + " · no separate install" +
            (ready ? "\nPrepared client " + prefs.getLong("prepared", 0) +
                (prefs.getInt("prepared_loader", 0) == BuildConfig.VERSION_CODE ? " · matching loader" : " · older loader; prepare again to update") : "\nPrepare a client to merge the loader"));
        boolean busy = ClientEngine.busy.get();
        fetch.setEnabled(!busy && !ClientEngine.installing.get()); fetch.setText(busy ? "Preparing client…" : installed > 0 ? "Prepare latest client" : "Download & prepare client");
        install.setEnabled(!busy && !ClientEngine.installing.get() && ready);
        managerInstall.setVisibility(ManagerUpdater.prepared(this).isFile() ? View.VISIBLE : View.GONE);
        managerInstall.setEnabled(!busy && !ClientEngine.installing.get());
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
        cancel.setVisibility(busy?View.VISIBLE:View.GONE);
        status.setText(busy ? ClientEngine.progress : getSharedPreferences("manager",0).getString("message","Ready"));
    }
    private void checkUpdates(boolean managerToo) {
        var prefs=getSharedPreferences("manager",0);
        if(!managerToo && System.currentTimeMillis()-prefs.getLong("lastCheck",0)<6*60*60*1000L)return;
        if(!checking.compareAndSet(false,true))return;
        try { worker.execute(() -> {
            try {
                long remote = ReleaseSource.latest();
                getSharedPreferences("manager",0).edit().putLong("latest",remote).putLong("lastCheck",System.currentTimeMillis()).apply();
                message(ClientEngine.needsUpdate(this,remote) ? "A client or loader update is available. Prepare the latest client." : "Discord and Assault loader are up to date.");
                if (managerToo || getSharedPreferences("manager",0).getBoolean("auto",true)) {
                    try { String result = ManagerUpdater.check(this); if (managerToo || ManagerUpdater.prepared(this).isFile()) message(result); }
                    catch(Exception error) { if (managerToo) message("Client check complete. Manager update unavailable: " + error.getMessage()); }
                }
            } catch (Exception e) { message("Update check failed: " + e.getMessage()); }
            finally {checking.set(false);}
        }); } catch(RejectedExecutionException e){checking.set(false);message("Reopen Manager to check updates.");}
    }
    private void prepare() {
        if (!ClientEngine.beginPrepare()) return;
        ClientEngine.progress = "Checking stable Discord release…";
        render();
        try {
            worker.execute(() -> {
                final long target;
                try { target = ReleaseSource.latest(); }
                catch(Exception e) { ClientEngine.busy.set(false); message("Preparation failed: " + e.getMessage()); return; }
                try { ClientEngine.prepareReserved(getApplicationContext(),target,this::message); }
                catch(Exception e) { message("Preparation failed: " + e.getMessage()); }
            });
        } catch (RejectedExecutionException e) {
            ClientEngine.busy.set(false);
            message("Manager closed before preparation started. Reopen it to retry.");
        }
    }
    private void openInstallPermission() {
        try{startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+getPackageName())));}
        catch(RuntimeException e){awaitingPermission=false;message("Open Android Settings → Apps → Special app access → Install unknown apps, and allow Assault Manager.");}
    }
    private void policySwitch(LinearLayout panel,String label,String key,boolean fallback){
        Switch control=new Switch(this);control.setText(label);control.setTextColor(WHITE);control.setChecked(getSharedPreferences("manager",0).getBoolean(key,fallback));panel.addView(control);
        control.setOnCheckedChangeListener((button,on)->{getSharedPreferences("manager",0).edit().putBoolean(key,on).apply();schedule(this);});
    }
    private void requestInstall() {
        if (!getPackageManager().canRequestPackageInstalls()) {
            awaitingPermission = true;
            openInstallPermission();
        } else confirmInstall();
    }
    private void confirmInstall() {
        new AlertDialog.Builder(this).setTitle("Install native Assault")
            .setMessage("Android will install the prepared Discord client. An existing official Discord install uses a different signing key and cannot be updated in place. If Android reports a conflict, remove it yourself in Settings after preparing the client; removal clears its local app data. Subsequent Assault updates keep your data while Manager retains its signing key. Uninstalling Manager or clearing its data permanently deletes that key; future updates then require reinstalling the client and losing its local app data.")
            .setNegativeButton("Cancel",null).setPositiveButton("Continue",(d,w)->installFiles(ClientEngine.prepared(this),ClientEngine.CLIENT)).show();
    }
    private void installFiles(List<File> files, String packageName) {
        if (!ClientEngine.beginInstall()) return;
        render();
        try { worker.execute(() -> {
            int sessionId = -1;
            PackageInstaller installer = getPackageManager().getPackageInstaller();
            try {
                if (files.isEmpty()) throw new IOException("Prepare the client first");
                if (ClientEngine.CLIENT.equals(packageName)) {
                    message("Checking prepared client integrity…");
                    ClientEngine.verifyPrepared(getApplicationContext(), files);
                }
                var params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(packageName);
                if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
                sessionId = installer.createSession(params);
                try (var session = installer.openSession(sessionId)) {
                    for (File file : files) {
                        try (InputStream in = new FileInputStream(file); OutputStream out = session.openWrite(file.getName(),0,file.length())) { ReleaseSource.copy(in, out); session.fsync(out); }
                    }
                    Intent callback = new Intent(this,InstallReceiver.class).setAction("app.assault.manager.INSTALL_RESULT").putExtra("assault.package", packageName).putExtra("assault.loader", getSharedPreferences("manager",0).getInt("prepared_loader",0));
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    session.commit(PendingIntent.getBroadcast(this,sessionId,callback,flags).getIntentSender());
                }
                message("Waiting for Android installation confirmation.");
            } catch(Exception e) {
                if (sessionId >= 0) { try { installer.abandonSession(sessionId); } catch(RuntimeException ignored) { } }
                ClientEngine.installing.set(false);
                message("Install failed: " + e.getMessage());
            }
        }); } catch (RejectedExecutionException e) {
            ClientEngine.installing.set(false);
            message("Manager closed before installation started. Reopen it to retry.");
        }
    }
    static void schedule(Context context) {
        JobScheduler scheduler=context.getSystemService(JobScheduler.class);if(scheduler==null)return;
        var prefs=context.getSharedPreferences("manager",0);
        if(!prefs.getBoolean("auto",true)){scheduler.cancel(26000);return;}
        int hours=prefs.getInt("intervalHours",24);if(hours!=6 && hours!=24 && hours!=72)hours=24;
        boolean unmetered=prefs.getBoolean("unmetered",true), charging=prefs.getBoolean("charging",true);
        String policy=hours+":"+unmetered+":"+charging;
        JobInfo old=scheduler.getPendingJob(26000);if(old!=null && policy.equals(old.getExtras().getString("policy")))return;
        PersistableBundle extras=new PersistableBundle();extras.putString("policy",policy);
        int result=scheduler.schedule(new JobInfo.Builder(26000,new ComponentName(context,UpdateJob.class))
            .setRequiredNetworkType(unmetered?JobInfo.NETWORK_TYPE_UNMETERED:JobInfo.NETWORK_TYPE_ANY).setRequiresCharging(charging)
            .setRequiresBatteryNotLow(true).setRequiresStorageNotLow(true).setPersisted(true).setPeriodic(hours*60L*60*1000).setExtras(extras).build());
        if(result!=JobScheduler.RESULT_SUCCESS)prefs.edit().putString("message","Android could not schedule updates. Manual checks remain available.").apply();
    }
    private void message(String message) { getSharedPreferences("manager",0).edit().putString("message",message).apply(); }
    @Override protected void onResume() { super.onResume(); getSharedPreferences("manager",0).registerOnSharedPreferenceChangeListener(changes); handler.post(refresh); if (awaitingPermission) { awaitingPermission=false; if (getPackageManager().canRequestPackageInstalls()) confirmInstall(); else message("Install permission was not granted."); } }
    @Override protected void onPause() { getSharedPreferences("manager",0).unregisterOnSharedPreferenceChangeListener(changes);handler.removeCallbacks(refresh); super.onPause(); }
    @Override public void onSaveInstanceState(Bundle state) { state.putBoolean("permission",awaitingPermission); super.onSaveInstanceState(state); }
    @Override protected void onDestroy() { worker.shutdown(); super.onDestroy(); }
    private int dp(int v) { return Math.round(v*getResources().getDisplayMetrics().density); }
    private LinearLayout card(LinearLayout page) {
        LinearLayout card = new LinearLayout(this); card.setOrientation(LinearLayout.VERTICAL); card.setPadding(dp(22),dp(18),dp(22),dp(18));
        GradientDrawable bg=new GradientDrawable(); bg.setColor(CARD); bg.setCornerRadius(dp(24)); card.setBackground(bg);
        LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2); params.topMargin=dp(20); page.addView(card,params); return card;
    }
    private TextView text(LinearLayout parent,String value,int size,int color,boolean bold) {
        TextView view=new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); view.setPadding(0,dp(6),0,dp(8));
        if(bold)view.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL)); parent.addView(view); return view;
    }
    private Button button(LinearLayout parent,String title,boolean primary,View.OnClickListener listener) {
        Button button=new Button(this); button.setText(title); button.setAllCaps(false); button.setTextColor(primary?BG:WHITE); button.setTextSize(15);
        GradientDrawable bg=new GradientDrawable(); bg.setColor(primary?MINT:0xff263348); bg.setCornerRadius(dp(16)); button.setBackground(bg);
        LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,dp(52)); params.topMargin=dp(12); parent.addView(button,params); button.setOnClickListener(listener); return button;
    }
}
