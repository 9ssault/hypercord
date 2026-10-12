package app.assault.loader;

import android.app.Activity;
import android.graphics.Rect;
import android.view.*;
import android.widget.FrameLayout;

/** Draggable native control; normalized coordinates survive rotation and window resizing. */
final class FloatingControl {
    private static final String TAG = "app.assault.floatingControl";
    static void attach(Activity activity, ViewGroup parent, View button) {
        button.setTag(TAG);
        var prefs = activity.getSharedPreferences("assault", 0);
        float density = activity.getResources().getDisplayMetrics().density;
        Runnable place = () -> {
            Rect bounds = bounds(parent,button);
            int width = bounds.width(), height = bounds.height();
            float x = prefs.contains("controlX") ? prefs.getFloat("controlX", 1) * width
                : prefs.getBoolean("leftControl", false) ? 8*density : width-8*density;
            float y = prefs.contains("controlY") ? prefs.getFloat("controlY", 0) * height : 48*density;
            button.setX(bounds.left+clamp(x, width)); button.setY(bounds.top+clamp(y, height));
        };
        // Absolute layout avoids gravity/margin offsets when applying saved coordinates.
        button.setLayoutParams(new FrameLayout.LayoutParams(Math.round(48*density), Math.round(48*density), Gravity.TOP|Gravity.LEFT));
        Rect previous=new Rect();
        ViewTreeObserver.OnGlobalLayoutListener listener=()->{
            Rect current=bounds(parent,button);
            if(!previous.equals(current)){previous.set(current);place.run();}
        };
        parent.getViewTreeObserver().addOnGlobalLayoutListener(listener);
        button.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener(){
            public void onViewAttachedToWindow(View view){
                // Re-register once if the same control is attached again.
                parent.getViewTreeObserver().removeOnGlobalLayoutListener(listener);
                parent.getViewTreeObserver().addOnGlobalLayoutListener(listener);place.run();
            }
            public void onViewDetachedFromWindow(View view){
                if(parent.getViewTreeObserver().isAlive())parent.getViewTreeObserver().removeOnGlobalLayoutListener(listener);
            }
        });
        button.post(place);
        int slop = ViewConfiguration.get(activity).getScaledTouchSlop();
        button.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY, startX, startY;
            boolean dragging;
            public boolean onTouch(View view, android.view.MotionEvent event) {
                switch(event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX=event.getRawX();downY=event.getRawY();startX=view.getX();startY=view.getY();dragging=false;return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx=event.getRawX()-downX, dy=event.getRawY()-downY;
                        if(!dragging && Math.hypot(dx,dy)>slop)dragging=true;
                        if(dragging){
                            parent.requestDisallowInterceptTouchEvent(true);
                            Rect bounds=bounds(parent,view);
                            view.setX(bounds.left+clamp(startX+dx-bounds.left,bounds.width()));
                            view.setY(bounds.top+clamp(startY+dy-bounds.top,bounds.height()));
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                        parent.requestDisallowInterceptTouchEvent(false);
                        if(dragging){
                            Rect bounds=bounds(parent,view);
                            prefs.edit().putFloat("controlX",(view.getX()-bounds.left)/Math.max(1,bounds.width()))
                                .putFloat("controlY",(view.getY()-bounds.top)/Math.max(1,bounds.height())).apply();
                        }
                        else view.performClick();
                        return true;
                    case MotionEvent.ACTION_CANCEL:
                        parent.requestDisallowInterceptTouchEvent(false);place.run();return true;
                    default:return true;
                }
            }
        });
    }
    static void reset(Activity activity) {
        activity.getSharedPreferences("assault",0).edit().remove("controlX").remove("controlY").apply();
        View button=activity.getWindow().getDecorView().findViewWithTag(TAG);
        if(button!=null && button.getParent() instanceof ViewGroup){
            ViewGroup parent=(ViewGroup)button.getParent();
            float density=activity.getResources().getDisplayMetrics().density;
            boolean left=activity.getSharedPreferences("assault",0).getBoolean("leftControl",false);
            Rect bounds=bounds(parent,button);
            button.setX(bounds.left+clamp(left?8*density:bounds.width()-8*density,bounds.width()));
            button.setY(bounds.top+clamp(48*density,bounds.height()));
        }
    }
    private static Rect bounds(ViewGroup parent,View button){
        // Visible frame reacts to IME/multi-window changes even when decor bounds stay fixed.
        Rect visible=new Rect();parent.getWindowVisibleDisplayFrame(visible);
        int[] origin=new int[2];parent.getLocationOnScreen(origin);
        int left=Math.max(0,visible.left-origin[0]),top=Math.max(0,visible.top-origin[1]);
        int right=Math.min(parent.getWidth(),visible.right-origin[0]);
        int bottom=Math.min(parent.getHeight(),visible.bottom-origin[1]);
        WindowInsets insets=parent.getRootWindowInsets();
        if(insets!=null && insets.getDisplayCutout()!=null){
            DisplayCutout cutout=insets.getDisplayCutout();
            left=Math.max(left,cutout.getSafeInsetLeft());top=Math.max(top,cutout.getSafeInsetTop());
            right=Math.min(right,parent.getWidth()-cutout.getSafeInsetRight());
            bottom=Math.min(bottom,parent.getHeight()-cutout.getSafeInsetBottom());
        }
        return new Rect(left,top,Math.max(left,right-button.getWidth()),Math.max(top,bottom-button.getHeight()));
    }

    private static float clamp(float value,int max){return Math.max(0,Math.min(value,Math.max(0,max)));}
}
