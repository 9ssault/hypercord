package app.assault.manager;

import android.content.Context;
import android.util.TypedValue;
import java.io.*;
import java.util.*;
import java.util.zip.ZipFile;
import pxb.android.axml.*;

/** Resolve the original application's icon IDs; never guess paths in a new Discord version. */
final class Branding {
    // Intentionally read compiled binary XML for insertion into another APK, not a Drawable object.
    @android.annotation.SuppressLint("ResourceType")
    static byte[] icon(Context context) throws IOException {
        try(InputStream in=context.getResources().openRawResource(R.drawable.ic_client_icon)){return ReleaseSource.readBounded(in,65536);}
    }
    static List<String> paths(Context context, File apk) throws Exception {
        Set<Integer> ids=new HashSet<>();
        try(ZipFile zip=new ZipFile(apk);InputStream in=zip.getInputStream(zip.getEntry("AndroidManifest.xml"))){
            new AxmlReader(ReleaseSource.readBounded(in,4*1024*1024)).accept(new AxmlVisitor(){
                @Override public NodeVisitor child(String ns,String name){
                    if(!"manifest".equals(name))return null;
                    return new NodeVisitor(){@Override public NodeVisitor child(String childNs,String childName){
                        if(!"application".equals(childName))return null;
                        return new NodeVisitor(){@Override public void attr(String attrNs,String attrName,int id,int type,Object value){
                            if(("icon".equals(attrName)||"roundIcon".equals(attrName)) && value instanceof Integer)ids.add((Integer)value);
                        }};
                    }};
                }
            });
        }
        var info=context.getPackageManager().getPackageArchiveInfo(apk.getPath(),0);
        if(info==null || info.applicationInfo==null)throw new IOException("Cannot resolve Discord launcher resources");
        info.applicationInfo.sourceDir=apk.getPath();info.applicationInfo.publicSourceDir=apk.getPath();
        var resources=context.getPackageManager().getResourcesForApplication(info.applicationInfo);
        Set<String> paths=new LinkedHashSet<>();
        for(int id:ids){
            TypedValue value=new TypedValue();resources.getValue(id,value,true);
            String path=value.string==null?"":value.string.toString();
            if(!path.startsWith("res/") || !path.endsWith(".xml"))throw new IOException("This Discord version has unsupported launcher icons. Keep your installed client and update Manager.");
            paths.add(path);
        }
        if(paths.isEmpty())throw new IOException("Discord launcher icon not found");
        return List.copyOf(paths);
    }
}
