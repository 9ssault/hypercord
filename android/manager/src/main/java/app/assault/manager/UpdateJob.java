package app.assault.manager;

import android.app.job.*;

public class UpdateJob extends JobService {
    private Thread thread;
    @Override public boolean onStartJob(JobParameters params) {
        if(!getSharedPreferences("manager",0).getBoolean("auto",true))return false;
        thread = new Thread(() -> {
            boolean retry = false;
            try {
                long latest = ReleaseSource.latest();
                var prefs = getSharedPreferences("manager",0);
                prefs.edit().putLong("latest",latest).apply();
                if (prefs.getBoolean("auto",true) && ClientEngine.installed(this) > 0
                    && ClientEngine.needsUpdate(this,latest) && (latest != prefs.getLong("prepared",0) || prefs.getInt("prepared_loader",0)!=BuildConfig.VERSION_CODE || ClientEngine.prepared(this).isEmpty())) {
                    ClientEngine.prepare(this,latest,message -> prefs.edit().putString("message",message).apply());
                }
                if (prefs.getBoolean("auto",true)) {
                    try { ManagerUpdater.check(this); }
                    catch(Exception e) { android.util.Log.i("HypercordUpdate", "Manager release check unavailable: " + e.getMessage()); }
                }
            } catch(Exception e) { retry=true; getSharedPreferences("manager",0).edit().putString("message","Automatic update: "+e.getMessage()).apply(); }
            if(!Thread.currentThread().isInterrupted())jobFinished(params,retry);
        },"assault-auto-update");
        thread.start(); return true;
    }
    @Override public boolean onStopJob(JobParameters params) { if(thread!=null)thread.interrupt(); return true; }
}
