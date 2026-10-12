package app.assault.loader;

import java.io.*;
import java.net.*;
import javax.net.ssl.HttpsURLConnection;

/** Attachment CDN requests carry no account credentials and never follow redirects. */
final class AttachmentDownload {
    static URL allowedUrl(String value)throws IOException {
        try {
            URI uri=new URI(value);
            String host=uri.getHost();
            if(!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo()!=null || (uri.getPort()!=-1 && uri.getPort()!=443) ||
               !("cdn.discordapp.com".equalsIgnoreCase(host) || "media.discordapp.net".equalsIgnoreCase(host)) ||
               uri.getPath()==null || !uri.getPath().startsWith("/attachments/"))throw new IOException("Unsupported attachment URL");
            return uri.toURL();
        } catch(URISyntaxException | IllegalArgumentException error){throw new IOException("Invalid attachment URL");}
    }
    static void fetch(String url,File target)throws IOException { fetch(url,target,()->false); }
    static void fetch(String url,File target,java.util.function.BooleanSupplier cancelled)throws IOException {
        if(cancelled.getAsBoolean())throw new IOException("Download cancelled");
        HttpsURLConnection connection=(HttpsURLConnection)allowedUrl(url).openConnection();
        connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(30000);
        try {
            int status=connection.getResponseCode();
            if(status!=200)throw new IOException("HTTP "+status);
            long expected=connection.getContentLengthLong(), total=0;
            try(InputStream in=connection.getInputStream();OutputStream out=new FileOutputStream(target)) {
                byte[] buffer=new byte[32768];int count;
                while((count=in.read(buffer))!=-1){if(cancelled.getAsBoolean())throw new IOException("Download cancelled");out.write(buffer,0,count);total+=count;}
            }
            if(expected>=0 && total!=expected)throw new IOException("Incomplete attachment response");
        } catch(IOException error) {
            // Do not expose response bodies, signed URLs or implementation exception text.
            String reason=error.getMessage();
            if(reason!=null && (reason.matches("HTTP [0-9]{3}") || reason.equals("Incomplete attachment response")))throw error;
            throw new IOException("Network or storage error");
        } finally { connection.disconnect(); }
    }
}
