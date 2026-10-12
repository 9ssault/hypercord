package app.assault.manager;

import android.content.Context;
import java.io.*;
import java.math.BigInteger;
import java.security.*;
import java.util.Date;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.lsposed.patch.KeystoreSpec;

final class Signing {
    static synchronized KeystoreSpec key(Context context) throws Exception {
        File file = new File(context.getFilesDir(), "client-signing.bks");
        // The key file is private to this installation and excluded from backup.
        String password = "assault-local-key";
        if (!file.exists()) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            KeyPair pair = generator.generateKeyPair();
            X500Name name = new X500Name("CN=Hypercord Local Client");
            var builder = new JcaX509v3CertificateBuilder(name, new BigInteger(128, new SecureRandom()),
                new Date(System.currentTimeMillis() - 86400000L), new Date(System.currentTimeMillis() + 946080000000L), name, pair.getPublic());
            var certificate = new JcaX509CertificateConverter().getCertificate(builder.build(new JcaContentSignerBuilder("SHA256withRSA").build(pair.getPrivate())));
            KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
            store.load(null, password.toCharArray());
            store.setKeyEntry("client", pair.getPrivate(), password.toCharArray(), new java.security.cert.Certificate[]{certificate});
            File temporary = new File(context.getFilesDir(), "client-signing.tmp");
            try (OutputStream out = new FileOutputStream(temporary)) { store.store(out, password.toCharArray()); }
            if (!temporary.renameTo(file)) throw new IOException("Could not save signing key");
        }
        return KeystoreSpec.of(file, password, "client", password);
    }
}
