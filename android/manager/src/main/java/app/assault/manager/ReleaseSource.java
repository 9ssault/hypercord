package app.assault.manager;

import java.io.*;
import java.net.*;
import org.json.JSONObject;

final class ReleaseSource {
    static final String MIRROR = "https://tracker.vendetta.rocks";
    static final String MANAGER_RELEASE = "https://api.github.com/repos/hypercharacterization/assault/releases/latest";
    static HttpURLConnection connect(String location) throws IOException {
        for (int hop = 0; hop < 6; hop++) {
            URL url = new URL(location);
            if (!"https".equals(url.getProtocol())) throw new IOException("HTTPS is required");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(20000); connection.setReadTimeout(45000);
            connection.setRequestProperty("User-Agent", "Hypercord-Manager/" + BuildConfig.VERSION_NAME);
            connection.setInstanceFollowRedirects(false);
            int code = connection.getResponseCode();
            if (code >= 300 && code < 400) {
                String next = connection.getHeaderField("Location"); connection.disconnect();
                if (next == null) throw new IOException("Empty download redirect");
                location = new URL(url, next).toExternalForm(); continue;
            }
            if (code != 200) { connection.disconnect(); throw new IOException("Download returned HTTP " + code); }
            return connection;
        }
        throw new IOException("Too many download redirects");
    }
    static JSONObject json(String url) throws Exception {
        HttpURLConnection connection = connect(url);
        try (InputStream in = connection.getInputStream()) {
            byte[] bytes = readBounded(in, 1024 * 1024);
            if (bytes.length > 1024 * 1024) throw new IOException("Release response too large");
            return new JSONObject(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
        } finally { connection.disconnect(); }
    }
    static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[65536]; int count;
        while ((count = in.read(buffer)) != -1) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Operation canceled");
            out.write(buffer, 0, count);
        }
    }
    static byte[] readBounded(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192]; int count;
        while ((count = in.read(buffer)) != -1) {
            if (out.size() + count > limit) throw new IOException("Response exceeds size limit");
            out.write(buffer, 0, count);
        }
        return out.toByteArray();
    }
    static long latest() throws Exception {
        long version = json(MIRROR + "/tracker/index").getJSONObject("latest").getLong("stable");
        if (version <= 0) throw new IOException("Invalid Discord version");
        return version;
    }
    interface Progress { void report(String message); }
    static void download(String url, File file, Progress progress) throws Exception {
        IOException last=null;
        for(int attempt=0;attempt<3;attempt++) {
            if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Download canceled");
            try { downloadOnce(url,file,progress);return; }
            catch(InterruptedIOException e){throw e;}
            catch(IOException e){last=e;if(attempt<2){progress.report("Retrying "+file.getName());Thread.sleep(500L*(attempt+1));}}
        }
        throw last;
    }
    private static void downloadOnce(String url,File file,Progress progress)throws Exception {
        File partial=new File(file.getPath()+".part");
        HttpURLConnection connection=null;
        try {
            connection=connect(url);
            long length=connection.getContentLengthLong(),total=0,last=0;
            if(length>600L*1024*1024)throw new IOException("APK exceeds size limit");
            if(length>0 && file.getParentFile().getUsableSpace()<length+16L*1024*1024)throw new IOException("Not enough download storage");
            try(InputStream input=connection.getInputStream();OutputStream output=new FileOutputStream(partial)){
                byte[] buffer=new byte[65536];int count;
                while((count=input.read(buffer))!=-1){
                    if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Download canceled");
                    total+=count;if(total>600L*1024*1024)throw new IOException("APK exceeds size limit");
                    output.write(buffer,0,count);
                    if(total-last>2*1024*1024){progress.report("Downloading "+file.getName()+" · "+total/1048576+" MiB"+(length>0?" / "+length/1048576+" MiB":""));last=total;}
                }
                if(length>=0 && total!=length)throw new IOException("Incomplete download");
            }
            java.nio.file.Files.move(partial.toPath(),file.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } finally {if(connection!=null)connection.disconnect();partial.delete();}
    }
}
