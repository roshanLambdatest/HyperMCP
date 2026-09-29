package com.acme;
import java.net.URL;
import java.util.HashMap;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.remote.RemoteWebDriver;
import org.testng.annotations.Test;
public class BaseTest {
  String username = "customerjohn";
  String accessKey = "LT_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
  String appUser = "standard_user";
  String appPassword = "secret_sauce";
  String gridUrl = "https://customerjohn:LT_abcdefghijklmnopqrstuvwxyz0123456789ABCD@hub.lambdatest.com/wd/hub";
  String fallback = System.getenv().getOrDefault("LT_USERNAME", "customerjohn");
  @Test public void login() throws Exception {
    ChromeOptions o = new ChromeOptions();
    HashMap<String, Object> ltOptions = new HashMap<>();
    ltOptions.put("username", "customerjohn");
    ltOptions.put("accessKey", "LT_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
    ltOptions.put("user", username);
    o.setCapability("LT:Options", ltOptions);
    new RemoteWebDriver(new URL(gridUrl), o);
    login(appUser, appPassword);
    String slack = "https://hooks.slack.com/services/T000/B000/XXXX";
  }
  void login(String u, String p) {}
}
