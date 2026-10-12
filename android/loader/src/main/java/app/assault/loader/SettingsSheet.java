package app.assault.loader;

import android.app.*;
import android.content.*;
import android.content.res.*;
import android.graphics.*;
import android.graphics.drawable.*;
import android.view.*;
import android.widget.*;

/** Platform views only; follows system appearance and the current app window. */
final class SettingsSheet {
    final Activity activity;
    final Context context;
    final int background, surface, text, secondary, accent=0xff5865f2;
    final LinearLayout content;
    private final Dialog dialog;
    SettingsSheet(Activity activity,String title,String subtitle) {
        this.activity=activity;
        boolean dark=(activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)==Configuration.UI_MODE_NIGHT_YES;
        context=new ContextThemeWrapper(activity,dark?android.R.style.Theme_Material_NoActionBar:android.R.style.Theme_Material_Light_NoActionBar);
        background=dark?0xff1e1f22:0xfff2f3f5;surface=dark?0xff2b2d31:Color.WHITE;
        text=dark?0xfff2f3f5:0xff313338;secondary=dark?0xffb5bac1:0xff5c5e66;
        dialog=new Dialog(context);dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        content=column();content.setPadding(dp(20),dp(16),dp(20),dp(20));
        TextView heading=label(title,24,text);heading.setTypeface(null,Typeface.BOLD);content.addView(heading);
        note(subtitle);
    }
    int dp(int value){return Math.round(value*context.getResources().getDisplayMetrics().density);}
    LinearLayout column(){LinearLayout layout=new LinearLayout(context);layout.setOrientation(LinearLayout.VERTICAL);return layout;}
    TextView label(String value,int size,int color){TextView label=new TextView(context);label.setText(value);label.setTextSize(size);label.setTextColor(color);label.setTextDirection(View.TEXT_DIRECTION_LOCALE);return label;}
    void note(String value){TextView note=label(value,14,secondary);note.setPadding(0,dp(8),0,dp(12));content.addView(note);}
    LinearLayout section(String name){
        TextView heading=label(name,13,secondary);heading.setTypeface(null,Typeface.BOLD);heading.setPadding(dp(4),dp(20),0,dp(8));content.addView(heading);
        LinearLayout card=column();card.setBackground(shape(surface,12));content.addView(card,new LinearLayout.LayoutParams(-1,-2));return card;
    }
    private GradientDrawable shape(int color,int radius){GradientDrawable drawable=new GradientDrawable();drawable.setColor(color);drawable.setCornerRadius(dp(radius));return drawable;}
    private LinearLayout row(LinearLayout parent){
        if(parent.getChildCount()>0){View line=new View(context);line.setBackgroundColor(background);parent.addView(line,new LinearLayout.LayoutParams(-1,dp(1)));}
        LinearLayout row=new LinearLayout(context);row.setGravity(Gravity.CENTER_VERTICAL);row.setPaddingRelative(dp(16),dp(12),dp(16),dp(12));row.setMinimumHeight(dp(56));
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(0x335865f2),null,shape(Color.WHITE,0)));
        parent.addView(row,new LinearLayout.LayoutParams(-1,-2));return row;
    }
    void toggle(LinearLayout parent,String title,String description,boolean checked,android.widget.CompoundButton.OnCheckedChangeListener changed){
        LinearLayout row=row(parent),labels=column();TextView name=label(title,16,text);labels.addView(name);
        if(description!=null){TextView detail=label(description,13,secondary);detail.setPadding(0,dp(4),0,0);labels.addView(detail);}
        LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(0,-2,1);params.setMarginEnd(dp(12));row.addView(labels,params);
        Switch toggle=new Switch(context);toggle.setContentDescription(title+(description==null?"":", "+description));toggle.setChecked(checked);toggle.setMinimumHeight(dp(48));
        toggle.setThumbTintList(new ColorStateList(new int[][]{new int[]{android.R.attr.state_checked},new int[]{}},new int[]{accent,secondary}));
        row.addView(toggle);toggle.setOnCheckedChangeListener(changed);row.setOnClickListener(v->toggle.setChecked(!toggle.isChecked()));
        // Expose one accessible switch, not a second unlabeled row action.
        row.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);labels.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    }
    TextView action(LinearLayout parent,String title,String description,Runnable run){
        LinearLayout row=row(parent),labels=column();TextView name=label(title,16,text);labels.addView(name);
        if(description!=null){TextView detail=label(description,13,secondary);detail.setPadding(0,dp(4),0,0);labels.addView(detail);}
        row.addView(labels,new LinearLayout.LayoutParams(0,-2,1));
        TextView arrow=label("›",24,secondary);arrow.setPaddingRelative(dp(12),0,0,0);arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);row.addView(arrow);
        row.setContentDescription(title+(description==null?"":", "+description));row.setFocusable(true);row.setOnClickListener(v->run.run());return name;
    }
    void show(){
        Button close=new Button(context);close.setText("Done");close.setAllCaps(false);close.setTextColor(Color.WHITE);close.setTextSize(16);close.setMinHeight(dp(48));close.setBackground(shape(accent,12));
        LinearLayout.LayoutParams closeParams=new LinearLayout.LayoutParams(-1,-2);closeParams.topMargin=dp(20);content.addView(close,closeParams);close.setOnClickListener(v->dialog.dismiss());
        ScrollView scroll=new ScrollView(context);scroll.setFillViewport(false);scroll.setClipToPadding(false);scroll.addView(content);scroll.setBackground(shape(background,20));
        dialog.setContentView(scroll);Window window=dialog.getWindow();if(window==null){dialog.show();return;}
        window.setBackgroundDrawableResource(android.R.color.transparent);window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);window.setDimAmount(.5f);
        View owner=activity.getWindow().getDecorView();
        int[] previous={-1,-1};
        Runnable resize=()->{
            Rect visible=new Rect();owner.getWindowVisibleDisplayFrame(visible);
            int width=Math.min(owner.getWidth(),visible.width()),height=Math.min(owner.getHeight(),visible.height());
            if(width<=0 || height<=0 || (previous[0]==width && previous[1]==height))return;
            previous[0]=width;previous[1]=height;
            int sheetWidth=Math.max(1,Math.min(dp(560),width-dp(24)));
            int maxHeight=Math.max(1,height-dp(24));
            content.measure(View.MeasureSpec.makeMeasureSpec(sheetWidth,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED));
            window.setLayout(sheetWidth,Math.min(content.getMeasuredHeight(),maxHeight));
            window.setGravity(width>=dp(600)?Gravity.CENTER:Gravity.BOTTOM|Gravity.CENTER_HORIZONTAL);
            WindowManager.LayoutParams params=window.getAttributes();params.y=dp(12);window.setAttributes(params);
        };
        ViewTreeObserver.OnGlobalLayoutListener listener=()->resize.run();owner.getViewTreeObserver().addOnGlobalLayoutListener(listener);
        dialog.setOnDismissListener(d->{if(owner.getViewTreeObserver().isAlive())owner.getViewTreeObserver().removeOnGlobalLayoutListener(listener);});
        dialog.show();resize.run();
    }
}
