package app.assault.loader;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import javax.net.ssl.HttpsURLConnection;

/** Bounded, redirect-free transport; no account credentials are inherited. */
final class AddonTransfer {
    static byte[] transfer(String operation, String address, String token, String expected, byte[] upload) throws Exception {
        return transfer(operation, address, token, expected, upload, () -> {});
    }
    static byte[] transfer(String operation, String address, String token, String expected, byte[] upload, Runnable timedOut) throws Exception {
        return transfer(operation, address, token, expected, upload, timedOut, 60000);
    }
    static byte[] transfer(String operation, String address, String token, String expected, byte[] upload, Runnable timedOut, long transferMillis) throws Exception {
        if (!operation.equals("download") && !operation.equals("uploadBackup") && !operation.equals("downloadBackup")) throw new IOException("Unknown addon operation.");
        URL url = new URL(address);
        if (!url.getProtocol().equals("https") || url.getUserInfo() != null || url.getRef() != null) throw new IOException("Use an HTTPS URL without credentials or fragment.");
        expected = expected.toLowerCase(java.util.Locale.ROOT);
        if (operation.equals("download") && !expected.matches("[0-9a-f]{64}")) throw new IOException("Enter the publisher's SHA-256 checksum.");
        if (token.length() > 4096 || token.contains("\r") || token.contains("\n")) throw new IOException("Invalid backup credential.");
        int limit = operation.equals("download") ? 64 * 1024 : 4 * 1024 * 1024;
        if (operation.equals("uploadBackup") && (upload.length == 0 || upload.length > limit)) throw new IOException("Invalid backup size.");
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
        connection.setRequestProperty("Accept", operation.equals("download") ? "application/javascript,text/plain" : "application/json");
        if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
        try (TransferDeadline deadline = new TransferDeadline(connection, timedOut, transferMillis)) {
            if (operation.equals("uploadBackup")) {
                connection.setRequestMethod("PUT"); connection.setDoOutput(true); connection.setFixedLengthStreamingMode(upload.length);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (OutputStream out = connection.getOutputStream()) { out.write(upload); }
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IOException("Server returned HTTP " + status + ". Redirects are not followed.");
            if (operation.equals("uploadBackup")) return new byte[0];
            long length = connection.getContentLengthLong();
            if (length > limit) throw new IOException("Download exceeds the size limit.");
            byte[] bytes;
            try (InputStream in = connection.getInputStream()) { bytes = read(in, limit, System.nanoTime() + 30_000_000_000L); }
            if (length >= 0 && bytes.length != length) throw new IOException("Incomplete download.");
            if (operation.equals("download")) {
                StringBuilder digest = new StringBuilder();
                for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) digest.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
                if (!digest.toString().equals(expected)) throw new IOException("Checksum mismatch. Nothing was installed.");
            }
            return bytes;
        } finally { connection.disconnect(); }
    }
    private static final class TransferDeadline implements AutoCloseable {
        private final java.util.Timer timer = new java.util.Timer("Assault transfer deadline", true);
        private boolean settled, expired;
        TransferDeadline(HttpsURLConnection connection, Runnable timedOut, long millis) {
            timer.schedule(new java.util.TimerTask() {
                @Override public void run() {
                    synchronized (TransferDeadline.this) {
                        if (settled) return;
                        settled = true; expired = true;
                    }
                    try { timedOut.run(); } finally { connection.disconnect(); }
                }
            }, millis);
        }
        @Override public void close() throws IOException {
            boolean timeout;
            synchronized (this) { settled = true; timeout = expired; }
            timer.cancel();
            if (timeout) throw new java.net.SocketTimeoutException("Transfer timed out. Check your connection and retry.");
        }
    }
    static String decode(byte[] bytes) throws IOException {
        return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
    }
    static byte[] read(InputStream in, int limit) throws IOException {
        return read(in, limit, Long.MAX_VALUE);
    }
    static byte[] read(InputStream in, int limit, long deadline) throws IOException {
        if (in == null) throw new IOException("File could not be opened.");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = in.read(buffer)) != -1) {
            if (System.nanoTime() > deadline) throw new IOException("Download timed out.");
            if (out.size() + count > limit) throw new IOException("File exceeds the size limit.");
            out.write(buffer, 0, count);
        }
        if (out.size() == 0) throw new IOException("File is empty.");
        return out.toByteArray();
    }
}
