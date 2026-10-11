package app.assault.manager;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/** Only the one-shot, explicit PendingIntent handed to Termux can deliver a result. */
public final class ScriptResultReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent.getData() == null) return;
        var future = ScriptProvider.RESULTS.get(intent.getData().getLastPathSegment());
        Bundle result = intent.getBundleExtra("result");
        if (future != null && result != null) future.complete(result);
    }
}
