// Mesh.java — guest-side proof client for the dsh-mobilecode co-op mesh (v0.8.0).
// Compiled with --release 8, packed with d8, pushed to /data/local/tmp/mesh.dex,
// then run INSIDE an emulator:  CLASSPATH=/data/local/tmp/mesh.dex app_process /Mesh <base> <mode> ...
// It exercises the ONLY path that matters for co-op: real HTTP from a device
// guest to the host hub at 10.0.2.2, through join / send / poll.
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URLEncoder;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

public class Mesh {
  static String base;

  static String read(HttpURLConnection c) throws Exception {
    InputStream in = c.getResponseCode() < 400 ? c.getInputStream() : c.getErrorStream();
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    if (in != null) {
      byte[] buf = new byte[4096];
      int n;
      while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }
    return out.toString("UTF-8");
  }

  static String post(String path, JSONObject body) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
    c.setRequestMethod("POST");
    c.setDoOutput(true);
    c.setConnectTimeout(5000);
    c.setReadTimeout(35000);
    c.getOutputStream().write(body.toString().getBytes("UTF-8"));
    return read(c);
  }

  static String get(String path) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
    c.setRequestMethod("GET");
    c.setConnectTimeout(5000);
    c.setReadTimeout(35000);
    return read(c);
  }

  public static void main(String[] a) throws Exception {
    base = a[0];
    String mode = a[1];
    if (mode.equals("join")) {
      JSONObject body = new JSONObject();
      body.put("serial", a[2]);
      System.out.println(post("/mesh/join", body).trim());
    } else if (mode.equals("send")) {
      JSONObject req = new JSONObject();
      req.put("id", a[2]);
      req.put("token", a[3]);
      req.put("session", a[4]);
      req.put("body", new JSONObject(a[5]));
      System.out.println(post("/mesh/send", req).trim());
    } else if (mode.equals("poll")) {
      long deadline = System.currentTimeMillis() + Long.parseLong(a[5]);
      String cursor = a.length > 6 ? a[6] : "0";
      String last = "{}";
      while (true) {
        last = get("/mesh/poll?id=" + URLEncoder.encode(a[2], "UTF-8")
          + "&token=" + URLEncoder.encode(a[3], "UTF-8")
          + "&after=" + cursor + "&wait=2000");
        JSONObject j = new JSONObject(last);
        JSONArray messages = j.optJSONArray("messages");
        if (messages != null && messages.length() > 0) break;
        cursor = j.optString("cursor", cursor);
        if (System.currentTimeMillis() > deadline) break;
      }
      System.out.println(last.trim());
    } else {
      System.out.println("{\"error\":\"unknown mode\"}");
    }
  }
}
