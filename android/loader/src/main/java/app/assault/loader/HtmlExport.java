package app.assault.loader;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.Context;
import android.os.SystemClock;
import android.widget.Toast;
import java.io.*;
import java.util.Arrays;
import java.util.HashSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/** Uses Android's document picker; no storage permission or exported component. */
final class HtmlExport {
    private static final long MAX_BYTES = 32L * 1024 * 1024;
    private static final long PICKER_TIMEOUT = 15L * 60 * 1000;
    private static int sequence;
    private static Session active;
    private static final class Session {
        final int request;
        final File pending;
        final String extension, mime;
        final boolean history, downloadAttachments;
        byte[] manifest;
        long manifestModified;
        volatile boolean cancelled;
        AlertDialog progress;
        final Activity activity;
        long pickerStarted;
        boolean picking;
        boolean writing;
        Session(Activity activity,int request,boolean json,boolean history,boolean downloadAttachments){this.activity=activity;this.request=request;this.history=history;this.downloadAttachments=downloadAttachments;extension=history?"zip":json?"json":"html";mime=history?"application/zip":json?"application/json":"text/html";pending=new File(activity.getCacheDir(),"assault-export-pending-"+request+"."+extension);}
    }
    static void save(Activity activity) { save(activity,false); }
    static void save(Activity activity,boolean json) { save(activity,json,false,false); }
    static void saveHistory(Activity activity,boolean attachments) { save(activity,false,true,attachments); }
    private static void save(Activity activity,boolean json,boolean history,boolean attachments) {
        final Session session;
        synchronized(HtmlExport.class) {
            // A lost callback must not permanently block later exports. Unique request codes
            // and snapshot files prevent a late old result from consuming a new transcript.
            if(active!=null && active.picking && !active.writing && SystemClock.elapsedRealtime()-active.pickerStarted>=PICKER_TIMEOUT){active.pending.delete();active=null;}
            if(active!=null){toast(activity,"Finish or cancel the current export first.");return;}
            if(sequence>=0x3fff){toast(activity,"Restart the client before another export.");return;}
            session=new Session(activity,0x4000 + ++sequence,json,history,attachments);active=session;
        }
        if(history) {
            session.progress=new AlertDialog.Builder(activity).setTitle("Preparing history archive")
                .setMessage(attachments?"Downloading available attachments. Large archives can take time.":"Packaging message pages.")
                .setNegativeButton("Cancel",(dialog,which)->session.cancelled=true).setCancelable(false).show();
        }
        new Thread(()->{
            try {
                if(history) snapshotHistory(activity,session);
                else {
                File source=new File(activity.getCacheDir(),"assault-export."+session.extension);
                if(!source.isFile() || source.length()==0)throw new IOException(json?"Run /hypercord → export-json first.":"Run /hypercord → export or export-all first.");
                try(InputStream in=new FileInputStream(source);OutputStream out=new FileOutputStream(session.pending)){copy(in,out,MAX_BYTES);}
                }
                activity.runOnUiThread(()->{
                    try {
                        if(session.progress!=null)session.progress.dismiss();
                        if(session.cancelled || activity.isFinishing() || activity.isDestroyed())throw new IllegalStateException();
                        synchronized(HtmlExport.class){if(active!=session)return;session.picking=true;session.pickerStarted=SystemClock.elapsedRealtime();}
                        Intent picker=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                            .setType(session.mime).putExtra(Intent.EXTRA_TITLE,"Hypercord-transcript."+session.extension);
                        activity.startActivityForResult(picker,session.request);
                    } catch(RuntimeException error){finish(session);toast(activity,"Document picker unavailable. Reopen the client and retry.");}
                });
            } catch(Exception error){finish(session);toast(activity,error.getMessage());}
        },"Hypercord export snapshot").start();
    }
    static void result(Activity activity,int request,int result,Intent data) {
        final Session session;
        synchronized(HtmlExport.class){
            if(active==null || active.request!=request || active.writing)return;
            session=active;
            if(result!=Activity.RESULT_OK || data==null || data.getData()==null){finish(session);return;}
            session.writing=true;
        }
        new Thread(()->{
            try {
                if(session.history) verifyHistory(activity,session);
                try(InputStream in=new FileInputStream(session.pending);OutputStream out=activity.getContentResolver().openOutputStream(data.getData(),"wt")){
                if(out==null)throw new IOException("Destination could not be opened");
                copy(in,out,session.history?Long.MAX_VALUE:MAX_BYTES);toast(activity,session.extension.toUpperCase(java.util.Locale.ROOT)+" transcript saved.");
                }
            }catch(Exception error){toast(activity,"Export failed: "+error.getMessage());}
            finally{finish(session);}
        },"Hypercord HTML export").start();
    }
    static void clearOldCache(Context context) {
        File[] files=context.getCacheDir().listFiles((dir,name)->name.startsWith("assault-history-") || name.startsWith("assault-export-pending-") || name.equals("assault-export.html") || name.equals("assault-export.json"));
        if(files!=null)for(File file:files)if(file.isFile())file.delete();
    }
    private static byte[] readManifest(Activity activity)throws IOException {
        File file=new File(activity.getCacheDir(),"assault-history-manifest.json");
        if(!file.isFile() || file.length()==0)throw new IOException("Run /hypercord → export-history first.");
        if(file.length()>MAX_BYTES)throw new IOException("History manifest exceeds the supported size.");
        return readBounded(file);
    }
    private static byte[] readBounded(File source)throws IOException {
        try(InputStream in=new FileInputStream(source);ByteArrayOutputStream out=new ByteArrayOutputStream()) {
            copy(in,out,MAX_BYTES);return out.toByteArray();
        }
    }
    private static void checkHistory(Activity activity,Session session)throws IOException {
        if(session.cancelled)throw new IOException("Archive cancelled.");
        File file=new File(activity.getCacheDir(),"assault-history-manifest.json");
        if(!file.isFile() || file.length()!=session.manifest.length || file.lastModified()!=session.manifestModified)
            throw new IOException("History archive changed or was cleared. Prepare and save it again.");
    }
    private static void verifyHistory(Activity activity,Session session)throws IOException {
        checkHistory(activity,session);
        if(!Arrays.equals(session.manifest,readManifest(activity)))throw new IOException("History archive changed or was cleared. Prepare and save it again.");
    }
    private static void snapshotHistory(Activity activity,Session session)throws Exception {
        session.manifest=readManifest(activity);
        session.manifestModified=new File(activity.getCacheDir(),"assault-history-manifest.json").lastModified();
        JSONObject manifest=new JSONObject(new String(session.manifest,java.nio.charset.StandardCharsets.UTF_8));
        if(!manifest.optBoolean("ready",false))throw new IOException("History archive is not ready. Finish cleanup and prepare it again.");
        JSONArray entries=manifest.getJSONArray("entries");
        File cache=activity.getCacheDir().getCanonicalFile();
        HashSet<String> names=new HashSet<>();
        JSONArray downloads=new JSONArray();
        HashSet<String> urls=new HashSet<>();
        try(ZipOutputStream zip=new ZipOutputStream(new FileOutputStream(session.pending))) {
            for(int i=0;i<entries.length();i++) {
                checkHistory(activity,session);
                JSONObject entry=entries.getJSONObject(i);
                String file=entry.getString("file"),name=entry.getString("name");
                if(!file.matches("assault-history-[0-9]+-[0-9]+-[0-9]+\\.(json|html)") ||
                   !name.matches("retained-session\\.json|channels/[0-9]{1,20}/[0-9]+\\.(json|html)") || !names.add(name))
                    throw new IOException("Invalid history archive entry.");
                File source=new File(cache,file).getCanonicalFile();
                if(!cache.equals(source.getParentFile()) || !source.isFile() || source.length()==0)
                    throw new IOException("History page missing. Prepare the archive again.");
                byte[] pageBytes=readBounded(source);
                zip.putNextEntry(new ZipEntry(name));
                zip.write(pageBytes);
                zip.closeEntry();
                if(name.endsWith(".json")) {
                    JSONObject page=new JSONObject(new String(pageBytes,java.nio.charset.StandardCharsets.UTF_8));
                    archiveAttachments(page,session,activity,zip,downloads,urls);
                }
            }
            manifest.put("attachmentDownloads",downloads);
            manifest.put("attachmentDownloadMode",session.downloadAttachments?"download":"links-only");
            zip.putNextEntry(new ZipEntry("manifest.json"));zip.write(manifest.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));zip.closeEntry();
        }
        verifyHistory(activity,session);
    }
    private static void archiveAttachments(Object value,Session session,Activity activity,ZipOutputStream zip,JSONArray reports,HashSet<String> seen)throws Exception {
        if(value instanceof JSONArray) {
            JSONArray array=(JSONArray)value;
            for(int i=0;i<array.length();i++)archiveAttachments(array.opt(i),session,activity,zip,reports,seen);
        } else if(value instanceof JSONObject) {
            JSONObject object=(JSONObject)value;
            JSONArray attachments=object.optJSONArray("attachments");
            if(attachments!=null)for(int i=0;i<attachments.length();i++) {
                JSONObject attachment=attachments.optJSONObject(i);if(attachment==null)continue;
                String url=attachment.optString("url","");if(url.isEmpty() || !seen.add(url))continue;
                JSONObject report=new JSONObject().put("url",url).put("filename",attachment.optString("filename","attachment"));
                reports.put(report);
                activity.runOnUiThread(()->{if(session.progress!=null)session.progress.setMessage("Processing attachment "+reports.length()+". Failed downloads will be listed in manifest.json.");});
                if(!session.downloadAttachments){report.put("status","links-only");continue;}
                checkHistory(activity,session);
                File pending=File.createTempFile("assault-history-media-",".tmp",activity.getCacheDir());
                try {
                    try { AttachmentDownload.fetch(url,pending,()->session.cancelled || !new File(activity.getCacheDir(),"assault-history-manifest.json").isFile()); }
                    catch(IOException failure) { report.put("status","unavailable").put("reason",failure.getMessage());continue; }
                    String name="attachments/"+reports.length()+"-"+attachment.optString("filename","attachment").replaceAll("[^A-Za-z0-9._-]","_");
                    checkHistory(activity,session);
                    zip.putNextEntry(new ZipEntry(name));
                    try(InputStream in=new FileInputStream(pending)){copy(in,zip,Long.MAX_VALUE);}
                    zip.closeEntry();report.put("status","downloaded").put("path",name).put("bytes",pending.length());
                } finally { pending.delete(); }
            }
            java.util.Iterator<String> keys=object.keys();
            while(keys.hasNext()){String key=keys.next();if(!key.equals("attachments"))archiveAttachments(object.opt(key),session,activity,zip,reports,seen);}
        }
    }
    private static synchronized void finish(Session session){if(session.progress!=null)session.activity.runOnUiThread(()->{try{session.progress.dismiss();}catch(IllegalArgumentException ignored){/* Activity window was already removed. */}});session.pending.delete();if(active==session)active=null;}
    private static void copy(InputStream in,OutputStream out,long maximum)throws IOException{
        byte[] buffer=new byte[32768];long total=0;int count;
        while((count=in.read(buffer))!=-1){total+=count;if(total>maximum)throw new IOException("An export component exceeds the 32 MiB safety limit.");out.write(buffer,0,count);}
    }
    private static void toast(Activity activity,String message){activity.runOnUiThread(()->Toast.makeText(activity,message==null?"Export failed":message,Toast.LENGTH_LONG).show());}
}
